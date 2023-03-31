import {
	BN,
	convertToNumber,
	DriftClient,
	User,
	isVariant,
	BASE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	PerpPosition,
	UserMap,
	ZERO,
	getTokenAmount,
	SpotPosition,
	PerpMarketAccount,
	SpotMarketAccount,
	QUOTE_SPOT_MARKET_INDEX,
	calculateClaimablePnl,
	calculateMarketAvailablePNL,
	SerumFulfillmentConfigMap,
	initialize,
	DriftEnv,
	getMarketOrderParams,
	findDirectionToClose,
	getSignedTokenAmount,
	standardizeBaseAssetAmount,
	TEN_THOUSAND,
	WrappedEvent,
	PositionDirection,
	BulkAccountLoader,
	PerpMarkets,
	SpotMarkets,
	isUserBankrupt,
} from '@drift-labs/sdk';
import { E_ALREADY_LOCKED, Mutex } from 'async-mutex';

import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import {
	ExplicitBucketHistogramAggregation,
	InstrumentType,
	MeterProvider,
	View,
} from '@opentelemetry/sdk-metrics-base';
import {
	Meter,
	ObservableGauge,
	BatchObservableResult,
	Histogram,
} from '@opentelemetry/api-metrics';

import { logger } from '../logger';
import { Bot } from '../types';
import { RuntimeSpec, metricAttrFromUserAccount } from '../metrics';
import { webhookMessage } from '../webhook';
import { getErrorCode } from '../error';
import { LiquidatorConfig } from '../config';
import {
	ComputeBudgetProgram,
	PublicKey,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';

const USER_MAP_RESYNC_COOLDOWN_SLOTS = 50;

// Use mempool price if we are fetching that specific oracle
function getRecentOraclePriceForPerpMarket(
	driftClient: DriftClient,
	recentOracle: PublicKey,
	recentPrice: BN,
	marketIndex: number
): BN {
	const oracleKey = driftClient.getPerpMarketAccount(marketIndex).amm.oracle;
	if (recentOracle.equals(oracleKey)) {
		return recentPrice;
	}

	return driftClient.getOraclePriceDataAndSlot(oracleKey).data.price;
}

function getRecentOraclePriceForSpotMarket(
	driftClient: DriftClient,
	recentOracle: PublicKey,
	recentPrice: BN,
	marketIndex: number
): BN {
	const oracleKey = driftClient.getSpotMarketAccount(marketIndex).oracle;
	if (recentOracle.equals(oracleKey)) {
		return recentPrice;
	}

	return driftClient.getOraclePriceDataAndSlot(oracleKey).data.price;
}

function wrapInTx(
	instruction: TransactionInstruction,
	computeUnits = 600_000,
	computeUnitsPrice = 0
): Transaction {
	const tx = new Transaction();
	// 200_000 = default compute units
	if (computeUnits != 200_000) {
		tx.add(
			ComputeBudgetProgram.setComputeUnitLimit({
				units: computeUnits,
			})
		);
	}

	if (computeUnitsPrice != 0) {
		tx.add(
			ComputeBudgetProgram.setComputeUnitPrice({
				microLamports: computeUnitsPrice,
			})
		);
	}

	return tx.add(instruction);
}

const LIQUIDATE_THROTTLE_BACKOFF = 20000; // the time to wait before trying to liquidate a throttled user again

function calculateSpotTokenAmountToLiquidate(
	driftClient: DriftClient,
	liquidatorUser: User,
	liquidateePosition: SpotPosition,
	recentOracle: PublicKey,
	recentPrice: BN,
	MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL: BN,
	MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL_DENOM: BN
): BN {
	const spotMarket = driftClient.getSpotMarketAccount(
		liquidateePosition.marketIndex
	);

	const tokenPrecision = new BN(10 ** spotMarket.decimals);

	const oraclePrice = getRecentOraclePriceForSpotMarket(
		driftClient,
		recentOracle,
		recentPrice,
		liquidateePosition.marketIndex
	);
	const collateralToSpend = liquidatorUser
		.getFreeCollateral()
		.mul(PRICE_PRECISION)
		.mul(MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL)
		.mul(tokenPrecision);
	const maxSpendTokenAmountToLiquidate = collateralToSpend.div(
		oraclePrice
			.mul(QUOTE_PRECISION)
			.mul(MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL_DENOM)
	);

	const liquidateeTokenAmount = getTokenAmount(
		liquidateePosition.scaledBalance,
		spotMarket,
		liquidateePosition.balanceType
	);

	if (maxSpendTokenAmountToLiquidate.gt(liquidateeTokenAmount)) {
		return liquidateeTokenAmount;
	} else {
		return maxSpendTokenAmountToLiquidate;
	}
}

function findBestSpotPosition(
	driftClient: DriftClient,
	liquidatorUser: User,
	spotPositions: SpotPosition[],
	isBorrow: boolean,
	recentOracle: PublicKey,
	recentPrice: BN,
	positionTakerOverPctNumerator: BN,
	positionTakerOverPctDenominator: BN
): [number, BN] {
	let bestIndex = -1;
	let bestAmount = ZERO;
	let currentAstWeight = 0;
	let currentLibWeight = Number.MAX_VALUE;

	for (const position of spotPositions) {
		if (position.scaledBalance.eq(ZERO)) {
			continue;
		}

		if (
			(isBorrow && isVariant(position.balanceType, 'deposit')) ||
			(!isBorrow && isVariant(position.balanceType, 'borrow'))
		) {
			continue;
		}

		const spotMarket = driftClient.getSpotMarketAccount(position.marketIndex);
		const tokenAmount = calculateSpotTokenAmountToLiquidate(
			driftClient,
			liquidatorUser,
			position,
			recentOracle,
			recentPrice,
			positionTakerOverPctNumerator,
			positionTakerOverPctDenominator
		);

		if (isBorrow) {
			if (spotMarket.maintenanceLiabilityWeight < currentLibWeight) {
				bestAmount = tokenAmount;
				bestIndex = position.marketIndex;
				currentAstWeight = spotMarket.maintenanceAssetWeight;
				currentLibWeight = spotMarket.maintenanceLiabilityWeight;
			}
		} else {
			if (spotMarket.maintenanceAssetWeight > currentAstWeight) {
				bestAmount = tokenAmount;
				bestIndex = position.marketIndex;
				currentAstWeight = spotMarket.maintenanceAssetWeight;
				currentLibWeight = spotMarket.maintenanceLiabilityWeight;
			}
		}
	}

	return [bestIndex, bestAmount];
}

async function liqPerpPnl(
	driftClient: DriftClient,
	user: User,
	perpMarketAccount: PerpMarketAccount,
	usdcAccount: SpotMarketAccount,
	liquidateePosition: PerpPosition,
	depositMarketIndextoLiq: number,
	depositAmountToLiq: BN,
	borrowMarketIndextoLiq: number,
	borrowAmountToLiq: BN
): Promise<Transaction> {
	let responseTx: Transaction;
	if (liquidateePosition.quoteAssetAmount.gt(ZERO)) {
		const claimablePnl = calculateClaimablePnl(
			perpMarketAccount,
			usdcAccount,
			liquidateePosition,
			this.driftClient.getOracleDataForPerpMarket(
				liquidateePosition.marketIndex
			)
		);

		let frac = new BN(100000000);
		if (claimablePnl.gt(ZERO)) {
			frac = BN.max(
				liquidateePosition.quoteAssetAmount.div(claimablePnl),
				new BN(1)
			);
		}

		if (frac.lt(new BN(100000000))) {
			const liqBorrowIx = await driftClient.getLiquidateBorrowForPerpPnlIx(
				user.userAccountPublicKey,
				user.getUserAccount(),
				liquidateePosition.marketIndex,
				borrowMarketIndextoLiq,
				borrowAmountToLiq.div(frac)
			);
			responseTx = wrapInTx(liqBorrowIx);
		} else {
			logger.info(
				`claimablePnl=${claimablePnl.toString()} << liquidateePosition.quoteAssetAmount=${liquidateePosition.quoteAssetAmount.toString()} `
			);
			logger.info(`skipping liquidateBorrowForPerpPnl`);
		}
	} else {
		const liqPerpPnlIx = await driftClient.getLiquidatePerpPnlForDepositIx(
			user.userAccountPublicKey,
			user.getUserAccount(),
			liquidateePosition.marketIndex,
			depositMarketIndextoLiq,
			depositAmountToLiq
		);
		responseTx = wrapInTx(liqPerpPnlIx);
	}
	return responseTx;
}

enum METRIC_TYPES {
	total_leverage = 'total_leverage',
	total_collateral = 'total_collateral',
	free_collateral = 'free_collateral',
	perp_posiiton_value = 'perp_position_value',
	perp_posiiton_base = 'perp_position_base',
	perp_posiiton_quote = 'perp_position_quote',
	initial_margin_requirement = 'initial_margin_requirement',
	maintenance_margin_requirement = 'maintenance_margin_requirement',
	initial_margin = 'initial_margin',
	maintenance_margin = 'maintenance_margin',
	unrealized_pnl = 'unrealized_pnl',
	unrealized_funding_pnl = 'unrealized_funding_pnl',
	sdk_call_duration_histogram = 'sdk_call_duration_histogram',
	runtime_specs = 'runtime_specs',
	user_map_user_account_keys = 'user_map_user_account_keys',
}

/**
 * LiquidatorBot implements a simple liquidation bot for the Drift V2 Protocol. Liquidations work by taking over
 * a portion of the endangered account's position, so collateral is required in order to run this bot. The bot
 * will spend at most MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL of its free collateral on any endangered account.
 *
 * The bot will immediately market sell any of its open positions if SELL_OPEN_POSITIONS is true.
 */
export class LiquidatorBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 5000;

	private metricsInitialized = false;
	private metricsPort: number | undefined;
	private meter: Meter;
	private exporter: PrometheusExporter;
	private bootTimeMs: number;
	private throttledUsers = new Map<string, number>();
	private disableAutoDerisking: boolean;

	// metrics
	private runtimeSpecsGauge: ObservableGauge;
	private totalLeverage: ObservableGauge;
	private totalCollateral: ObservableGauge;
	private freeCollateral: ObservableGauge;
	private perpPositionValue: ObservableGauge;
	private perpPositionBase: ObservableGauge;
	private perpPositionQuote: ObservableGauge;
	private initialMarginRequirement: ObservableGauge;
	private maintenanceMarginRequirement: ObservableGauge;
	private unrealizedPnL: ObservableGauge;
	private unrealizedFundingPnL: ObservableGauge;
	private sdkCallDurationHistogram: Histogram;
	private userMapUserAccountKeysGauge: ObservableGauge;

	private bulkAccountLoader: BulkAccountLoader | undefined;
	private driftClient: DriftClient;
	private perpMarketIndicies: number[];
	private spotMarketIndicies: number[];
	private activeSubAccountId: number;
	private perpMarketToSubaccount: Map<number, number>;
	private spotMarketToSubaccount: Map<number, number>;
	private intervalIds: Array<NodeJS.Timer> = [];
	private userMapMutex = new Mutex();
	private userMap: UserMap;
	private lastSeenNumberOfSubAccounts: number;
	private deriskMutex = new Uint8Array(new SharedArrayBuffer(1));
	private runtimeSpecs: RuntimeSpec;
	private serumFulfillmentConfigMap: SerumFulfillmentConfigMap;

	/**
	 * Max percentage of collateral to spend on liquidating a single position.
	 */
	private MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL = new BN(50);
	private MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL_DENOM = new BN(100);

	/**
	 * Immediately sell any open positions.
	 */
	private SELL_OPEN_POSITIONS = true;

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();

	private lastSlotResyncUserMapsMutex = new Mutex();
	private lastSlotResyncUserMaps = 0;

	constructor(
		bulkAccountLoader: BulkAccountLoader | undefined,
		driftClient: DriftClient,
		runtimeSpec: RuntimeSpec,
		config: LiquidatorConfig,
		defaultSubaccountId: number
	) {
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.bulkAccountLoader = bulkAccountLoader;
		this.driftClient = driftClient;
		this.runtimeSpecs = runtimeSpec;
		this.serumFulfillmentConfigMap = new SerumFulfillmentConfigMap(
			this.driftClient
		);
		this.bootTimeMs = Date.now();

		this.metricsPort = config.metricsPort;
		if (this.metricsPort) {
			this.initializeMetrics();
		}

		if (!config.disableAutoDerisking) {
			this.disableAutoDerisking = false;
		} else {
			this.disableAutoDerisking = config.disableAutoDerisking;
		}
		logger.info(
			`${this.name} disableAutoDerisking: ${this.disableAutoDerisking}`
		);

		this.activeSubAccountId = defaultSubaccountId;
		this.perpMarketToSubaccount = new Map<number, number>();
		this.spotMarketToSubaccount = new Map<number, number>();

		if (config.perpSubAccountConfig) {
			logger.info('Loading perp markets to watch from perpSubAccountConfig');
			for (const subAccount of Object.keys(config.perpSubAccountConfig)) {
				for (const market of config.perpSubAccountConfig[subAccount]) {
					this.perpMarketToSubaccount.set(market, parseInt(subAccount));
				}
			}
			this.perpMarketIndicies = Object.values(
				config.perpSubAccountConfig
			).flat();
		} else {
			logger.info('Loading perp markets to watch from perpMarketIndicies');
			this.perpMarketIndicies = config.perpMarketIndicies || [];
			if (!this.perpMarketIndicies || this.perpMarketIndicies.length === 0) {
				this.perpMarketIndicies = PerpMarkets[
					this.runtimeSpecs.driftEnv as DriftEnv
				].map((m) => {
					this.perpMarketToSubaccount.set(
						m.marketIndex,
						this.activeSubAccountId
					);
					return m.marketIndex;
				});
			}
		}
		logger.info(`${this.name} perpMarketIndicies: ${this.perpMarketIndicies}`);
		console.log('this.perpMarketToSubaccount:');
		console.log(this.perpMarketToSubaccount);

		if (config.spotSubAccountConfig) {
			logger.info('Loading spot markets to watch from spotSubAccountConfig');
			for (const subAccount of Object.keys(config.spotSubAccountConfig)) {
				for (const market of config.spotSubAccountConfig[subAccount]) {
					this.spotMarketToSubaccount.set(market, parseInt(subAccount));
				}
			}
			this.spotMarketIndicies = Object.values(
				config.spotSubAccountConfig
			).flat();
		} else {
			this.spotMarketIndicies = config.spotMarketIndicies || [];
			if (!this.spotMarketIndicies || this.spotMarketIndicies.length === 0) {
				for (const m of SpotMarkets[this.runtimeSpecs.driftEnv as DriftEnv]) {
					this.spotMarketToSubaccount.set(
						m.marketIndex,
						this.activeSubAccountId
					);
					this.spotMarketIndicies.push(m.marketIndex);
				}
			}
		}
		logger.info(`${this.name} spotMarketIndicies: ${this.spotMarketIndicies}`);
		console.log('this.spotMarketToSubaccount:');
		console.log(this.spotMarketToSubaccount);
	}

	public async init() {
		logger.info(`${this.name} initing`);
		// initialize userMap instance
		await this.userMapMutex.runExclusive(async () => {
			this.userMap = new UserMap(
				this.driftClient,
				this.driftClient.userAccountSubscriptionConfig
			);
			await this.userMap.fetchAllUsers();
			this.lastSeenNumberOfSubAccounts = this.driftClient
				.getStateAccount()
				.numberOfSubAccounts.toNumber();
		});

		const config = initialize({ env: this.runtimeSpecs.driftEnv as DriftEnv });
		for (const spotMarketConfig of config.SPOT_MARKETS) {
			if (spotMarketConfig.serumMarket) {
				// set up fulfillment config
				await this.serumFulfillmentConfigMap.add(
					spotMarketConfig.marketIndex,
					spotMarketConfig.serumMarket
				);
			}
		}

		await webhookMessage(`[${this.name}]: started`);
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId);
		}
		this.intervalIds = [];
		await this.userMapMutex.runExclusive(async () => {
			for (const user of this.userMap.values()) {
				await user.unsubscribe();
			}
			delete this.userMap;
		});
	}

	public async trigger(record: WrappedEvent<any>) {
		// potentially a race here, but the lock is really slow :/
		// await this.userMapMutex.runExclusive(async () => {
		await this.userMap.updateWithEventRecord(record);
		// });
	}

	/**
	 * Checks that userMap and userStatsMap are up in sync with , if not, signal that we should update them next block.
	 */
	private async resyncUserMapsIfRequired() {
		const stateAccount = this.driftClient.getStateAccount();
		const resyncRequired =
			this.lastSeenNumberOfSubAccounts !==
			stateAccount.numberOfSubAccounts.toNumber();

		if (resyncRequired) {
			logger.info(
				`this.userMap.size()(${this.userMap.size()}) !== stateAccount.numberOfSubAccounts.toNumber()(${stateAccount.numberOfSubAccounts.toNumber()})`
			);
			await this.lastSlotResyncUserMapsMutex.runExclusive(async () => {
				let doResync = false;
				const start = Date.now();
				if (!this.bulkAccountLoader) {
					logger.info(`Resyncing UserMaps immediately(no BulkAccountLoader)`);
					doResync = true;
				} else {
					const nextResyncSlot =
						this.lastSlotResyncUserMaps + USER_MAP_RESYNC_COOLDOWN_SLOTS;
					if (nextResyncSlot >= this.bulkAccountLoader.mostRecentSlot) {
						const slotsRemaining =
							nextResyncSlot - this.bulkAccountLoader.mostRecentSlot;
						if (slotsRemaining % 10 === 0) {
							logger.info(
								`Resyncing UserMaps in cooldown, ${slotsRemaining} more slots to go`
							);
						}
						return;
					} else {
						doResync = true;
						this.lastSlotResyncUserMaps = this.bulkAccountLoader.mostRecentSlot;
					}
				}

				if (doResync) {
					logger.info(`Resyncing UserMap`);
					this.userMap
						.sync(false)
						.then(async () => {
							await this.userMapMutex.runExclusive(async () => {
								this.lastSeenNumberOfSubAccounts = this.driftClient
									.getStateAccount()
									.numberOfSubAccounts.toNumber();
							});
						})
						.finally(() => {
							logger.info(`UserMaps resynced in ${Date.now() - start} ms`);
						});
				}
			});
		}
	}

	public async startIntervalLoop(intervalMs: number): Promise<void> {
		const intervalId = setInterval(this.tryLiquidate.bind(this), intervalMs);
		this.intervalIds.push(intervalId);

		if (!this.disableAutoDerisking) {
			const deRiskIntervalId = setInterval(this.derisk.bind(this), 10000);
			this.intervalIds.push(deRiskIntervalId);
		}

		logger.info(`${this.name} Bot started!`);

		const freeCollateral = this.driftClient.getUser().getFreeCollateral();
		logger.info(
			`${this.name} free collateral: $${convertToNumber(
				freeCollateral,
				QUOTE_PRECISION
			)}, spending at most ${
				(this.MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL.toNumber() /
					this.MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL_DENOM.toNumber()) *
				100.0
			}% per liquidation`
		);
	}

	public async healthCheck(): Promise<boolean> {
		let healthy = false;

		// check if we've ran the main loop recently
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime > Date.now() - 2 * this.defaultIntervalMs;
		});

		const stateAccount = this.driftClient.getStateAccount();
		const userMapResyncRequired =
			this.lastSeenNumberOfSubAccounts !==
			stateAccount.numberOfSubAccounts.toNumber();

		healthy = healthy && !userMapResyncRequired;

		if (!healthy) {
			logger.error(
				`Bot ${this.name} is unhealthy, userMapResyncRequired: ${userMapResyncRequired} `
			);
		}

		return healthy;
	}

	public viewDlob(): undefined {
		return undefined;
	}

	/**
	 * attempts to close out any open positions on this account. It starts by cancelling any open orders
	 */
	private async derisk() {
		if (Atomics.compareExchange(this.deriskMutex, 0, 0, 1) === 1) {
			return;
		}

		if (!this.SELL_OPEN_POSITIONS) {
			return;
		}

		try {
			const userAccount = this.driftClient.getUserAccount();

			// close open positions
			for (const position of userAccount.perpPositions) {
				if (!position.baseAssetAmount.isZero()) {
					const positionPlusOpenOrders = position.baseAssetAmount.gt(ZERO)
						? position.baseAssetAmount.add(position.openAsks)
						: position.baseAssetAmount.add(position.openBids);

					// check if open orders already net out with current position before placing new order
					if (
						position.baseAssetAmount.gt(ZERO) &&
						positionPlusOpenOrders.lte(ZERO)
					) {
						continue;
					}

					if (
						position.baseAssetAmount.lt(ZERO) &&
						positionPlusOpenOrders.gte(ZERO)
					) {
						continue;
					}

					const start = Date.now();
					this.driftClient
						.placePerpOrder(
							getMarketOrderParams({
								direction: findDirectionToClose(position),
								baseAssetAmount: positionPlusOpenOrders,
								reduceOnly: true,
								marketIndex: position.marketIndex,
							})
						)
						.then((tx) => {
							logger.info(
								`placePerpOrder on market ${position.marketIndex.toString()}: ${tx} `
							);
						})
						.catch((e) => {
							logger.error(e);
							logger.error(
								`Error trying to close perp position for market ${position.marketIndex}`
							);
							webhookMessage(
								`[${this.name}]: : x: error in placePerpOrder\n:${
									e.stack ? e.stack : e.message
								} `
							);
						})
						.then(() => {
							this.sdkCallDurationHistogram.record(Date.now() - start, {
								method: 'placePerpOrder',
							});
						});
				} else if (position.quoteAssetAmount.lt(ZERO)) {
					const start = Date.now();
					this.driftClient
						.settlePNL(
							await this.driftClient.getUserAccountPublicKey(),
							userAccount,
							position.marketIndex
						)
						.then((tx) => {
							logger.info(
								`settling negative perp pnl on market ${position.marketIndex.toString()}: ${tx} `
							);
						})
						.catch((e) => {
							logger.error(e);
							logger.error(
								`Error trying to settle negative perp pnl for market ${position.marketIndex}`
							);
							webhookMessage(
								`[${this.name}]: : x: error in settlePNL for negative pnl\n:${
									e.stack ? e.stack : e.message
								} `
							);
						})
						.finally(() => {
							this.sdkCallDurationHistogram.record(Date.now() - start, {
								method: 'settlePNL',
							});
						});
				} else if (position.quoteAssetAmount.gt(ZERO)) {
					const availablePnl = calculateMarketAvailablePNL(
						this.driftClient.getPerpMarketAccount(position.marketIndex),
						this.driftClient.getQuoteSpotMarketAccount()
					);

					if (availablePnl.gt(ZERO)) {
						const start = Date.now();
						this.driftClient
							.settlePNL(
								await this.driftClient.getUserAccountPublicKey(),
								userAccount,
								position.marketIndex
							)
							.then((tx) => {
								logger.info(
									`settling positive perp pnl on market ${position.marketIndex.toString()}: ${tx} `
								);
							})
							.catch((e) => {
								logger.error(e);
								logger.error(
									`Error trying to settle positive perp pnl for market ${position.marketIndex}`
								);
								webhookMessage(
									`[${this.name}]: : x: error in settlePNL for positive pnl\n:${
										e.stack ? e.stack : e.message
									} `
								);
							})
							.finally(() => {
								this.sdkCallDurationHistogram.record(Date.now() - start, {
									method: "'settlePNL",
								});
							});
					}
				}
			}

			for (const position of userAccount.spotPositions) {
				if (position.scaledBalance.eq(ZERO) || position.marketIndex === 0) {
					continue;
				}

				// need to standardize token amount to check if its closable via market orders
				const standardizedTokenAmount = getSignedTokenAmount(
					standardizeBaseAssetAmount(
						getTokenAmount(
							position.scaledBalance,
							this.driftClient.getSpotMarketAccount(position.marketIndex),
							position.balanceType
						),
						this.driftClient.getSpotMarketAccount(position.marketIndex)
							.orderStepSize
					),
					position.balanceType
				);

				const positionPlusOpenOrders = standardizedTokenAmount.gt(ZERO)
					? standardizedTokenAmount.add(position.openAsks)
					: standardizedTokenAmount.add(position.openBids);

				// check if open orders already net out with current position before placing new order
				if (positionPlusOpenOrders.eq(ZERO)) {
					continue;
				}

				if (isVariant(position.balanceType, 'deposit')) {
					const start = Date.now();
					this.driftClient
						.placeSpotOrder(
							getMarketOrderParams({
								marketIndex: position.marketIndex,
								direction: PositionDirection.SHORT,
								baseAssetAmount: standardizedTokenAmount,
								reduceOnly: true,
							})
						)
						.then((tx) => {
							logger.info(
								`closing spot position for market ${position.marketIndex.toString()}: ${tx} `
							);
						})
						.catch((e) => {
							logger.error(
								`Error trying to close spot position for market ${position.marketIndex}`
							);
							console.error(e);
							webhookMessage(
								`[${
									this.name
								}]: : x: error trying to close spot position on market ${
									position.marketIndex
								} \n:${e.stack ? e.stack : e.message} `
							);
						})
						.finally(() => {
							this.sdkCallDurationHistogram.record(Date.now() - start, {
								method: 'placeAndTakeSpotOrder',
							});
						});
				} else {
					const start = Date.now();
					this.driftClient
						.placeSpotOrder(
							getMarketOrderParams({
								marketIndex: position.marketIndex,
								direction: PositionDirection.LONG,
								baseAssetAmount: standardizedTokenAmount,
								reduceOnly: true,
							})
						)
						.then((tx) => {
							logger.info(
								`closing spot position for market ${position.marketIndex.toString()}: ${tx} `
							);
						})
						.catch((e) => {
							logger.error(
								`Error trying to close spot position for market ${position.marketIndex}`
							);
							console.error(e);
							webhookMessage(
								`[${
									this.name
								}]: : x: error trying to close spot position on market ${
									position.marketIndex
								} \n:${e.stack ? e.stack : e.message} `
							);
						})
						.finally(() => {
							this.sdkCallDurationHistogram.record(Date.now() - start, {
								method: 'placeAndTakeSpotOrder',
							});
						});
				}
			}
		} finally {
			Atomics.store(this.deriskMutex, 0, 0);
		}
	}

	private calculateBaseAmountToLiquidate(
		liquidatorUser: User,
		liquidateePosition: PerpPosition,
		recentOracle: PublicKey,
		recentPrice: BN
	): BN {
		const oraclePrice = getRecentOraclePriceForPerpMarket(
			this.driftClient,
			recentOracle,
			recentPrice,
			liquidateePosition.marketIndex
		);
		const collateralToSpend = liquidatorUser
			.getFreeCollateral()
			.mul(PRICE_PRECISION)
			.mul(this.MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL)
			.mul(BASE_PRECISION);
		const baseAssetAmountToLiquidate = collateralToSpend.div(
			oraclePrice
				.mul(QUOTE_PRECISION)
				.mul(this.MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL_DENOM)
		);

		if (
			baseAssetAmountToLiquidate.gt(liquidateePosition.baseAssetAmount.abs())
		) {
			return liquidateePosition.baseAssetAmount.abs();
		} else {
			return baseAssetAmountToLiquidate;
		}
	}

	/**
	 * Find the user perp position with the largest loss, resolve bankruptcy on this market.
	 *
	 * @param chUserToCheck
	 * @returns
	 */
	private findPerpBankruptingMarkets(chUserToCheck: User): Array<number> {
		const bankruptMarketIndices: Array<number> = [];

		for (const market of this.driftClient.getPerpMarketAccounts()) {
			const position = chUserToCheck.getPerpPosition(market.marketIndex);
			if (!position || position.quoteAssetAmount.gte(ZERO)) {
				// invalid position to liquidate
				continue;
			}
			bankruptMarketIndices.push(position.marketIndex);
		}

		return bankruptMarketIndices;
	}

	/**
	 * Find the user spot position with the largest loss, resolve bankruptcy on this market.
	 *
	 * @param chUserToCheck
	 * @returns
	 */
	private findSpotBankruptingMarkets(chUserToCheck: User): Array<number> {
		const bankruptMarketIndices: Array<number> = [];

		for (const market of this.driftClient.getSpotMarketAccounts()) {
			const position = chUserToCheck.getSpotPosition(market.marketIndex);
			if (!position) {
				continue;
			}
			if (!isVariant(position.balanceType, 'borrow')) {
				// not possible to resolve non-borrow markets
				continue;
			}
			if (position.scaledBalance.lte(ZERO)) {
				// invalid borrow
				continue;
			}
			bankruptMarketIndices.push(position.marketIndex);
		}

		return bankruptMarketIndices;
	}

	private async tryResolveBankruptUser(user: User) {
		const userAcc = user.getUserAccount();
		const userKey = user.getUserAccountPublicKey();

		// find out whether the user is perp-bankrupt or spot-bankrupt
		const bankruptPerpMarkets = this.findPerpBankruptingMarkets(user);
		const bankruptSpotMarkets = this.findSpotBankruptingMarkets(user);

		logger.info(
			`User ${userKey.toBase58()} is bankrupt in perpMarkets: ${bankruptPerpMarkets} and spotMarkets: ${bankruptSpotMarkets} `
		);

		// resolve bankrupt markets
		for (const perpIdx of bankruptPerpMarkets) {
			logger.info(
				`Resolving perp market for userAcc: ${userKey.toBase58()}, marketIndex: ${perpIdx} `
			);
			webhookMessage(
				`[${
					this.name
				}]: Resolving perp market for userAcc: ${userKey.toBase58()}, marketIndex: ${perpIdx} `
			);
			const start = Date.now();
			this.driftClient
				.resolvePerpBankruptcy(userKey, userAcc, perpIdx)
				.then((tx) => {
					logger.info(
						`Resolved perp bankruptcy for userAcc: ${userKey.toBase58()}, marketIndex: ${perpIdx}: ${tx} `
					);
					webhookMessage(
						`[${
							this.name
						}]: Resolved perp market for userAcc: ${userKey.toBase58()}, marketIndex: ${perpIdx}: ${tx} `
					);
				})
				.catch((e) => {
					logger.error(e);
					logger.error(
						`Error resolvePerpBankruptcy for ${userKey.toBase58()}, auth: ${userAcc.authority.toBase58()} `
					);
					webhookMessage(
						`[${
							this.name
						}]: : x: Error resolvePerpBankruptcy for ${userKey.toBase58()}, auth: ${userAcc.authority.toBase58()} \n:${
							e.stack ? e.stack : e.message
						} `
					);
				})
				.finally(() => {
					this.sdkCallDurationHistogram.record(Date.now() - start, {
						method: 'resolvePerpBankruptcy',
					});
				});
		}

		for (const spotIdx of bankruptSpotMarkets) {
			logger.info(
				`Resolving spot market for userAcc: ${userKey.toBase58()}, marketIndex: ${spotIdx} `
			);
			webhookMessage(
				`[${
					this.name
				}]: Resolving spot market for userAcc: ${userKey.toBase58()}, marketIndex: ${spotIdx} `
			);
			const start = Date.now();
			this.driftClient
				.resolveSpotBankruptcy(userKey, userAcc, spotIdx)
				.then((tx) => {
					logger.info(
						`Resolved spot market for userAcc: ${userKey.toBase58()}, marketIndex: ${spotIdx}: ${tx} `
					);
					webhookMessage(
						`[${
							this.name
						}]: Resolved spot market for userAcc: ${userKey.toBase58()}, marketIndex: ${spotIdx}: ${tx} `
					);
				})
				.catch((e) => {
					logger.error(e);
					logger.error(
						`Error resolveSpotpBankruptcy for ${userKey.toBase58()}, auth: ${userAcc.authority.toBase58()} `
					);
					webhookMessage(
						`[${
							this.name
						}]: : x: Error resolveSpotBankruptcy for ${userKey.toBase58()}, auth: ${userAcc.authority.toBase58()}: \n${
							e.stack ? e.stack : e.message
						} `
					);
				})
				.finally(() => {
					this.sdkCallDurationHistogram.record(Date.now() - start, {
						method: 'resolveSpotBankruptcy',
					});
				});
		}
	}

	private async liqPerpPnl(
		user: User,
		perpMarketAccount: PerpMarketAccount,
		usdcAccount: SpotMarketAccount,
		liquidateePosition: PerpPosition,
		depositMarketIndextoLiq: number,
		depositAmountToLiq: BN,
		borrowMarketIndextoLiq: number,
		borrowAmountToLiq: BN
	) {
		if (liquidateePosition.quoteAssetAmount.gt(ZERO)) {
			const claimablePnl = calculateClaimablePnl(
				perpMarketAccount,
				usdcAccount,
				liquidateePosition,
				this.driftClient.getOracleDataForPerpMarket(
					liquidateePosition.marketIndex
				)
			);

			if (claimablePnl.gt(ZERO) && borrowMarketIndextoLiq === -1) {
				this.driftClient
					.settlePNL(
						user.userAccountPublicKey,
						user.getUserAccount(),
						liquidateePosition.marketIndex
					)
					.then((tx) => {
						logger.info(
							`settled positive pnl for ${user.userAccountPublicKey.toBase58()} for market ${
								liquidateePosition.marketIndex
							}: ${tx} `
						);
						webhookMessage(
							`[${
								this.name
							}]: settled positive pnl for ${user.userAccountPublicKey.toBase58()} for market ${
								liquidateePosition.marketIndex
							}: ${tx} `
						);
					})
					.catch((e) => {
						logger.error(e);
						logger.error(
							`Error settling positive pnl for ${user.userAccountPublicKey.toBase58()} for market ${
								liquidateePosition.marketIndex
							}`
						);
						webhookMessage(
							`[${
								this.name
							}]: : x: Error settling positive pnl for ${user.userAccountPublicKey.toBase58()} for market ${
								liquidateePosition.marketIndex
							}: \n${e.stack ? e.stack : e.message} `
						);
					});
				return;
			}

			let frac = new BN(100000000);
			if (claimablePnl.gt(ZERO)) {
				frac = BN.max(
					liquidateePosition.quoteAssetAmount.div(claimablePnl),
					new BN(1)
				);
			}

			if (frac.lt(new BN(100000000))) {
				if (!this.spotMarketIndicies.includes(borrowMarketIndextoLiq)) {
					logger.info(
						`skipping liquidateBorrowForPerpPnl of ${user.userAccountPublicKey.toBase58()} on market ${borrowMarketIndextoLiq} because it is not in spotMarketIndices`
					);
					return;
				} else {
					const subAccountToUse = this.spotMarketToSubaccount.get(
						borrowMarketIndextoLiq
					);
					logger.info(
						`Switching to subaccount ${subAccountToUse} for spot market ${borrowMarketIndextoLiq}`
					);
					this.driftClient.switchActiveUser(subAccountToUse);
				}
				const start = Date.now();
				this.driftClient
					.liquidateBorrowForPerpPnl(
						user.userAccountPublicKey,
						user.getUserAccount(),
						liquidateePosition.marketIndex,
						borrowMarketIndextoLiq,
						borrowAmountToLiq.div(frac)
					)
					.then((tx) => {
						logger.info(
							`liquidateBorrowForPerpPnl for userAccount ${user.userAccountPublicKey.toBase58()} on market ${
								liquidateePosition.marketIndex
							} tx: ${tx} `
						);
						webhookMessage(
							`[${
								this.name
							}]: liquidateBorrowForPerpPnl for userAccount ${user.userAccountPublicKey.toBase58()} on market ${
								liquidateePosition.marketIndex
							} tx: ${tx} `
						);
					})
					.catch((e) => {
						logger.error(
							`Error in liquidateBorrowForPerpPnl for userAccount ${user.userAccountPublicKey.toBase58()} on market ${
								liquidateePosition.marketIndex
							} `
						);
						logger.error(e);
						const errorCode = getErrorCode(e);
						if (!errorCodesToSuppress.includes(errorCode)) {
							webhookMessage(
								`[${
									this.name
								}]: : x: error in liquidateBorrowForPerpPnl for ${user.userAccountPublicKey.toBase58()} on market ${
									liquidateePosition.marketIndex
								}: \n${e.logs ? (e.logs as Array<string>).join('\n') : ''} \n${
									e.stack ? e.stack : e.message
								} `
							);
						} else {
							this.throttledUsers.set(
								user.userAccountPublicKey.toBase58(),
								Date.now()
							);
						}
					})
					.finally(() => {
						this.sdkCallDurationHistogram.record(Date.now() - start, {
							method: 'liquidateBorrowForPerpPnl',
						});
					});
			} else {
				logger.info(
					`claimablePnl = ${claimablePnl.toString()} << liquidateePosition.quoteAssetAmount=${liquidateePosition.quoteAssetAmount.toString()} `
				);
				logger.info(`skipping liquidateBorrowForPerpPnl`);
			}
		} else {
			const start = Date.now();

			if (!this.spotMarketIndicies.includes(depositMarketIndextoLiq)) {
				logger.info(
					`skipping liquidatePerpPnlForDeposit of ${user.userAccountPublicKey.toBase58()} on spot market ${depositMarketIndextoLiq} because it is not in spotMarketIndices`
				);
				return;
			}

			if (!this.perpMarketIndicies.includes(liquidateePosition.marketIndex)) {
				logger.info(
					`skipping liquidatePerpPnlForDeposit of ${user.userAccountPublicKey.toBase58()} on perp market ${
						liquidateePosition.marketIndex
					} because it is not in perpMarketIndices`
				);
				return;
			}

			const subAccountToUse = this.perpMarketToSubaccount.get(
				liquidateePosition.marketIndex
			);
			logger.info(
				`Switching to subaccount ${subAccountToUse} for perp market ${liquidateePosition.marketIndex}`
			);
			this.driftClient.switchActiveUser(subAccountToUse);

			this.driftClient
				.liquidatePerpPnlForDeposit(
					user.userAccountPublicKey,
					user.getUserAccount(),
					liquidateePosition.marketIndex,
					depositMarketIndextoLiq,
					depositAmountToLiq
				)
				.then((tx) => {
					logger.info(
						`did liquidatePerpPnlForDeposit for ${user.userAccountPublicKey.toBase58()} on market ${
							liquidateePosition.marketIndex
						} tx: ${tx} `
					);
					webhookMessage(
						`[${
							this.name
						}]: liquidatePerpPnlForDeposit for ${user.userAccountPublicKey.toBase58()} on market ${
							liquidateePosition.marketIndex
						} tx: ${tx} `
					);
				})
				.catch((e) => {
					console.error(e);
					logger.error('Error in liquidatePerpPnlForDeposit');
					const errorCode = getErrorCode(e);
					if (!errorCodesToSuppress.includes(errorCode)) {
						webhookMessage(
							`[${
								this.name
							}]: : x: error in liquidatePerpPnlForDeposit for userAccount ${user.userAccountPublicKey.toBase58()} on market ${
								liquidateePosition.marketIndex
							}: \n${e.logs ? (e.logs as Array<string>).join('\n') : ''} \n${
								e.stack ? e.stack : e.message
							} `
						);
					} else {
						this.throttledUsers.set(
							user.userAccountPublicKey.toBase58(),
							Date.now()
						);
					}
				})
				.finally(() => {
					this.sdkCallDurationHistogram.record(Date.now() - start, {
						method: 'liquidatePerpPnlForDeposit',
					});
				});
		}
	}

	/**
	 * iterates over users in userMap and checks:
	 * 		1. is user bankrupt? if so, resolve bankruptcy
	 * 		2. is user in liquidation? If so, endangered position is liquidated
	 */
	public async tryLiquidate(
		recentOracle: PublicKey,
		recentPrice: BN
	): Promise<Transaction[]> {
		const start = Date.now();
		let ran = false;
		const bundle: Transaction[] = [];
		try {
			await this.resyncUserMapsIfRequired();

			for (const user of this.userMap.values()) {
				const userAcc = user.getUserAccount();
				const auth = userAcc.authority.toBase58();
				const userKey = user.userAccountPublicKey.toBase58();

				if (isVariant(userAcc.status, 'bankrupt')) {
					await this.tryResolveBankruptUser(user);
				} else if (user.canBeLiquidated()) {
					logger.info(`liquidating auth: ${auth}G, userAccount: ${userKey}...`);
					webhookMessage(
						`[${this.name}]: liquidating auth: ${auth}: userAccount: ${userKey} ...`
					);

					const liquidatorUser = this.driftClient.getUser();
					const liquidateeUserAccount = user.getUserAccount();

					// most attractive spot market liq
					const [depositMarketIndextoLiq, depositAmountToLiq] =
						findBestSpotPosition(
							this.driftClient,
							liquidatorUser,
							liquidateeUserAccount.spotPositions,
							false,
							recentOracle,
							recentPrice,
							this.MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL,
							this.MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL_DENOM
						);

					const [borrowMarketIndextoLiq, borrowAmountToLiq] =
						findBestSpotPosition(
							this.driftClient,
							liquidatorUser,
							liquidateeUserAccount.spotPositions,
							true,
							recentOracle,
							recentPrice,
							this.MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL,
							this.MAX_POSITION_TAKEOVER_PCT_OF_COLLATERAL_DENOM
						);

					if (borrowMarketIndextoLiq != -1 && depositMarketIndextoLiq != -1) {
						const liquidateSpotIx = await this.driftClient.getLiquidateSpotIx(
							user.userAccountPublicKey,
							user.getUserAccount(),
							depositMarketIndextoLiq,
							borrowMarketIndextoLiq,
							borrowAmountToLiq
						);
						console.log('pushing to bundle', liquidateSpotIx);
						bundle.push(wrapInTx(liquidateSpotIx));
					}

					const usdcMarket = this.driftClient.getSpotMarketAccount(
						QUOTE_SPOT_MARKET_INDEX
					);

					// less attractive, perp / perp pnl liquidations
					for (const liquidateePosition of liquidateeUserAccount.perpPositions) {
						if (liquidateePosition.baseAssetAmount.isZero()) {
							if (!liquidateePosition.quoteAssetAmount.isZero()) {
								const perpMarket = this.driftClient.getPerpMarketAccount(
									liquidateePosition.marketIndex
								);
								bundle.push(
									await liqPerpPnl(
										this.driftClient,
										user,
										perpMarket,
										usdcMarket,
										liquidateePosition,
										depositMarketIndextoLiq,
										depositAmountToLiq,
										borrowMarketIndextoLiq,
										borrowAmountToLiq
									)
								);
								console.log('pushing to bundle ', bundle[bundle.length - 1]);
								break; // todo: exit loop to reload accounts etc?
							}
							continue;
						}

						const baseAmountToLiquidate = this.calculateBaseAmountToLiquidate(
							liquidatorUser,
							liquidateePosition,
							recentOracle,
							recentPrice
						);

						if (baseAmountToLiquidate.gt(ZERO)) {
							if (this.dryRun) {
								logger.warn(
									'--dry run flag enabled - not sending liquidate tx'
								);
							}
							const liqPerpIx = await this.driftClient.getLiquidatePerpIx(
								user.userAccountPublicKey,
								user.getUserAccount(),
								liquidateePosition.marketIndex,
								baseAmountToLiquidate
							);
							console.log('pushing to bundle', liqPerpIx);
							bundle.push(wrapInTx(liqPerpIx));
						}
					}
				} else if (isVariant(userAcc.status, 'beingLiquidated')) {
					// no-op to clear user of beingLiquidated status
					logger.info(
						`[${
							this.name
						}]: user stuck in beingLiquidated status, clearing it for ${user.userAccountPublicKey.toBase58()}`
					);
					const liqPerpIx = await this.driftClient.getLiquidatePerpIx(
						user.userAccountPublicKey,
						user.getUserAccount(),
						0,
						ZERO
					);
					console.log('pushing to bundle', liqPerpIx);
					bundle.push(wrapInTx(liqPerpIx));
				}
			}

			if (!this.disableAutoDerisking) {
				const startDerisk = Date.now();
				await this.derisk();
				logger.debug(`derisk took ${Date.now() - startDerisk} ms`);
			}
			ran = true;
		} catch (e) {
			if (e === E_ALREADY_LOCKED) {
				console.error("mutex already locked, can't run");
			} else {
				console.error(e);
				webhookMessage(
					`[${this.name}]: : x: uncaught error: \n${
						e.stack ? e.stack : e.message
					} `
				);
			}
		} finally {
			if (ran) {
				logger.debug(`${this.name} Bot took ${Date.now() - start}ms to run`);
				await this.watchdogTimerMutex.runExclusive(async () => {
					this.watchdogTimerLastPatTime = Date.now();
				});
			}
		}
		return bundle;
	}

	private initializeMetrics() {
		if (this.metricsInitialized) {
			logger.error('Tried to initilaize metrics multiple times');
			return;
		}
		this.metricsInitialized = true;

		const { endpoint: defaultEndpoint } = PrometheusExporter.DEFAULT_OPTIONS;
		this.exporter = new PrometheusExporter(
			{
				port: this.metricsPort,
				endpoint: defaultEndpoint,
			},
			() => {
				logger.info(
					`prometheus scrape endpoint started: http://localhost:${this.metricsPort}${defaultEndpoint}`
				);
			}
		);
		const meterName = this.name;
		const meterProvider = new MeterProvider({
			views: [
				new View({
					instrumentName: METRIC_TYPES.sdk_call_duration_histogram,
					instrumentType: InstrumentType.HISTOGRAM,
					meterName: meterName,
					aggregation: new ExplicitBucketHistogramAggregation(
						Array.from(new Array(20), (_, i) => 0 + i * 100),
						true
					),
				}),
			],
		});

		meterProvider.addMetricReader(this.exporter);
		this.meter = meterProvider.getMeter(meterName);

		this.runtimeSpecsGauge = this.meter.createObservableGauge(
			METRIC_TYPES.runtime_specs,
			{
				description: 'Runtime sepcification of this program',
			}
		);
		this.runtimeSpecsGauge.addCallback((obs) => {
			obs.observe(1, this.runtimeSpecs);
		});

		this.totalLeverage = this.meter.createObservableGauge(
			METRIC_TYPES.total_leverage,
			{
				description: 'Total leverage of the account',
			}
		);
		this.totalCollateral = this.meter.createObservableGauge(
			METRIC_TYPES.total_collateral,
			{
				description: 'Total collateral of the account',
			}
		);
		this.freeCollateral = this.meter.createObservableGauge(
			METRIC_TYPES.free_collateral,
			{
				description: 'Free collateral of the account',
			}
		);
		this.perpPositionValue = this.meter.createObservableGauge(
			METRIC_TYPES.perp_posiiton_value,
			{
				description: 'Value of account perp positions',
			}
		);
		this.perpPositionBase = this.meter.createObservableGauge(
			METRIC_TYPES.perp_posiiton_base,
			{
				description: 'Base asset value of account perp positions',
			}
		);
		this.perpPositionQuote = this.meter.createObservableGauge(
			METRIC_TYPES.perp_posiiton_quote,
			{
				description: 'Quote asset value of account perp positions',
			}
		);
		this.initialMarginRequirement = this.meter.createObservableGauge(
			METRIC_TYPES.initial_margin_requirement,
			{
				description: 'The account initial margin requirement',
			}
		);
		this.maintenanceMarginRequirement = this.meter.createObservableGauge(
			METRIC_TYPES.maintenance_margin_requirement,
			{
				description: 'The account maintenance margin requirement',
			}
		);
		this.unrealizedPnL = this.meter.createObservableGauge(
			METRIC_TYPES.unrealized_pnl,
			{
				description: 'The account unrealized PnL',
			}
		);
		this.unrealizedFundingPnL = this.meter.createObservableGauge(
			METRIC_TYPES.unrealized_funding_pnl,
			{
				description: 'The account unrealized funding PnL',
			}
		);

		this.sdkCallDurationHistogram = this.meter.createHistogram(
			METRIC_TYPES.sdk_call_duration_histogram,
			{
				description: 'Distribution of sdk method calls',
				unit: 'ms',
			}
		);

		this.userMapUserAccountKeysGauge = this.meter.createObservableGauge(
			METRIC_TYPES.user_map_user_account_keys,
			{
				description: 'number of user account keys in UserMap',
			}
		);
		this.userMapUserAccountKeysGauge.addCallback(async (obs) => {
			obs.observe(this.userMap.size());
		});

		this.meter.addBatchObservableCallback(
			async (batchObservableResult: BatchObservableResult) => {
				// each subaccount is responsible for a market
				// record account specific metrics
				for (const [idx, user] of this.driftClient.getUsers().entries()) {
					const accMarketIdx = idx;
					const userAccount = user.getUserAccount();
					const oracle =
						this.driftClient.getOracleDataForPerpMarket(accMarketIdx);

					batchObservableResult.observe(
						this.totalLeverage,
						convertToNumber(user.getLeverage(), TEN_THOUSAND),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);
					batchObservableResult.observe(
						this.totalCollateral,
						convertToNumber(user.getTotalCollateral(), QUOTE_PRECISION),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);
					batchObservableResult.observe(
						this.freeCollateral,
						convertToNumber(user.getFreeCollateral(), QUOTE_PRECISION),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);
					batchObservableResult.observe(
						this.perpPositionValue,
						convertToNumber(
							user.getPerpPositionValue(accMarketIdx, oracle),
							QUOTE_PRECISION
						),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);

					const perpPosition = user.getPerpPosition(accMarketIdx);
					batchObservableResult.observe(
						this.perpPositionBase,
						convertToNumber(perpPosition.baseAssetAmount, BASE_PRECISION),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);
					batchObservableResult.observe(
						this.perpPositionQuote,
						convertToNumber(perpPosition.quoteAssetAmount, QUOTE_PRECISION),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);

					batchObservableResult.observe(
						this.initialMarginRequirement,
						convertToNumber(
							user.getInitialMarginRequirement(),
							QUOTE_PRECISION
						),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);
					batchObservableResult.observe(
						this.maintenanceMarginRequirement,
						convertToNumber(
							user.getMaintenanceMarginRequirement(),
							QUOTE_PRECISION
						),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);
					batchObservableResult.observe(
						this.unrealizedPnL,
						convertToNumber(user.getUnrealizedPNL(), QUOTE_PRECISION),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);
					batchObservableResult.observe(
						this.unrealizedFundingPnL,
						convertToNumber(user.getUnrealizedFundingPNL(), QUOTE_PRECISION),
						metricAttrFromUserAccount(user.userAccountPublicKey, userAccount)
					);
				}
			},
			[
				this.totalLeverage,
				this.totalCollateral,
				this.freeCollateral,
				this.perpPositionValue,
				this.perpPositionBase,
				this.perpPositionQuote,
				this.initialMarginRequirement,
				this.maintenanceMarginRequirement,
				this.unrealizedPnL,
				this.unrealizedFundingPnL,
			]
		);
	}
}
