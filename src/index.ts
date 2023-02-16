import fs from 'fs';
import { program, Option } from 'commander';
import * as http from 'http';

import {
	SearcherClient,
	searcherClient,
} from 'jito-ts/dist/sdk/block-engine/searcher';


import * as Fs from 'fs';

import {
	Connection,
	Commitment,
	Keypair,
	PublicKey,
	Transaction,
} from '@solana/web3.js';
import {
	Token,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	BulkAccountLoader,
	DriftClient,
	User,
	initialize,
	Wallet,
	EventSubscriber,
	SlotSubscriber,
	convertToNumber,
	QUOTE_PRECISION,
	SpotMarkets,
	PerpMarkets,
	BN,
	TokenFaucet,
	DriftClientSubscriptionConfig,
	LogProviderConfig,
} from '@drift-labs/sdk';

import { logger, setLogLevel } from './logger';
import { constants } from './types';
import { FillerBot } from './bots/filler';
import { SpotFillerBot } from './bots/spotFiller';
import { TriggerBot } from './bots/trigger';
import { JitMakerBot } from './bots/jitMaker';
import { LiquidatorBot } from './bots/liquidator';
import { FloatingPerpMakerBot } from './bots/floatingMaker';
import { Bot } from './types';
import { IFRevenueSettlerBot } from './bots/ifRevenueSettler';
import { UserPnlSettlerBot } from './bots/userPnlSettler';
import {
	getOrCreateAssociatedTokenAccount,
	TOKEN_FAUCET_PROGRAM_ID,
} from './utils';
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes';
import {
	Config,
	configHasBot,
	loadConfigFromFile,
	loadConfigFromOpts,
} from './config';
import { getPythProgramKeyForCluster } from '@pythnetwork/client';
import { encode } from 'bs58';
import { deserialize } from 'borsh';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';

require('dotenv').config();
const commitHash = process.env.COMMIT;

const stateCommitment: Commitment = 'confirmed';
const healthCheckPort = process.env.HEALTH_CHECK_PORT || 8888;

program
	.option('-d, --dry-run', 'Dry run, do not send transactions on chain')
	.option(
		'--init-user',
		'calls driftClient.initializeUserAccount if no user account exists'
	)
	.option('--filler', 'Enable filler bot')
	.option('--spot-filler', 'Enable spot filler bot')
	.option('--trigger', 'Enable trigger bot')
	.option('--jit-maker', 'Enable JIT auction maker bot')
	.option('--floating-maker', 'Enable floating maker bot')
	.option('--liquidator', 'Enable liquidator bot')
	.option('--if-revenue-settler', 'Enable Insurance Fund PnL settler bot')
	.option('--user-pnl-settler', 'Enable User PnL settler bot')
	.option('--cancel-open-orders', 'Cancel open orders on startup')
	.option('--close-open-positions', 'close all open positions')
	.option('--test-liveness', 'Purposefully fail liveness test after 1 minute')
	.option(
		'--force-deposit <number>',
		'Force deposit this amount of USDC to collateral account, the program will end after the deposit transaction is sent'
	)
	.option('--metrics <number>', 'Enable Prometheus metric scraper (deprecated)')
	.addOption(
		new Option(
			'-p, --private-key <string>',
			'private key, supports path to id.json, or list of comma separate numbers'
		).env('KEEPER_PRIVATE_KEY')
	)
	.option('--debug', 'Enable debug logging')
	.option(
		'--run-once',
		'Exit after running bot loops once (only for supported bots)'
	)
	.option(
		'--websocket',
		'Use websocket instead of RPC polling for account updates'
	)
	.option(
		'--disable-auto-derisking',
		'Set to disable auto derisking (primarily used for liquidator to close inherited positions)'
	)
	.option(
		'--subaccount <string>',
		'subaccount(s) to use (comma delimited), specify which subaccountsIDs to load',
		'0'
	)
	.option(
		'--perp-markets <string>',
		'comma delimited list of perp market ID(s) to liquidate (willing to inherit risk), omit for all',
		''
	)
	.option(
		'--spot-markets <string>',
		'comma delimited list of spot market ID(s) to liquidate (willing to inherit risk), omit for all',
		''
	)
	.option(
		'--transaction-version <number>',
		'Select transaction version (omit for legacy transaction)',
		''
	)
	.option(
		'--config-file <string>',
		'Config file to load (yaml format), will override any other config options',
		''
	)
	.option(
		'--use-jito',
		'Submit transactions to a Jito relayer if the bot supports it'
	)
	.parse();

const opts = program.opts();
let config: Config = undefined;
if (opts.configFile) {
	logger.info(`Loading config from ${opts.configFile}`);
	config = loadConfigFromFile(opts.configFile);
} else {
	logger.info(`Loading config from command line options`);
	config = loadConfigFromOpts(opts);
}
logger.info(
	`Bot config:\n${JSON.stringify(
		config,
		(k, v) => {
			if (k === 'keeperPrivateKey') {
				return '*'.repeat(v.length);
			}
			return v;
		},
		2
	)}`
);

// @ts-ignore
const sdkConfig = initialize({ env: config.global.driftEnv });
console.log(opts);
setLogLevel(opts.debug ? 'debug' : 'info');

logger.info(`Dry run: ${!!opts.dry},\n\
FillerBot enabled: ${!!opts.filler},\n\
SpotFillerBot enabled: ${!!opts.spotFiller},\n\
TriggerBot enabled: ${!!opts.trigger},\n\
JitMakerBot enabled: ${!!opts.jitMaker},\n\
IFRevenueSettler enabled: ${!!opts.ifRevenueSettler},\n\
userPnlSettler enabled: ${!!opts.userPnlSettler},\n\
`);

logger.info(
	`Bot config:\n${JSON.stringify(
		config,
		(k, v) => {
			if (k === 'keeperPrivateKey') {
				return '*'.repeat(v.length);
			}
			return v;
		},
		2
	)}`
);

// @ts-ignore
const sdkConfig = initialize({ env: config.global.driftEnv });

setLogLevel(config.global.debug ? 'debug' : 'info');

function loadKeypair(privateKey: string): Keypair {
	// try to load privateKey as a filepath
	let loadedKey: Uint8Array;
	if (fs.existsSync(privateKey)) {
		logger.info(`loading private key from ${privateKey}`);
		loadedKey = new Uint8Array(
			JSON.parse(fs.readFileSync(privateKey).toString())
		);
	} else {
		if (privateKey.includes(',')) {
			logger.info(`Trying to load private key as comma separated numbers`);
			loadedKey = Uint8Array.from(
				privateKey.split(',').map((val) => Number(val))
			);
		} else {
			logger.info(`Trying to load private key as base58 string`);
			loadedKey = new Uint8Array(bs58.decode(privateKey));
		}
	}

	return Keypair.fromSecretKey(Uint8Array.from(loadedKey));
}

export function getWallet(): [Keypair, Wallet] {
	const privateKey = config.global.keeperPrivateKey;
	if (!privateKey) {
		throw new Error(
			'Must set environment variable KEEPER_PRIVATE_KEY with the path to a id.json or a list of commma separated numbers'
		);
	}
	const keypair = loadKeypair(privateKey);
	return [keypair, new Wallet(keypair)];
}

const endpoint = config.global.endpoint;
const wsEndpoint = config.global.wsEndpoint;
logger.info(`RPC endpoint: ${endpoint}`);
logger.info(`WS endpoint:  ${wsEndpoint}`);
logger.info(`DriftEnv:     ${config.global.driftEnv}`);
logger.info(`Commit:       ${commitHash}`);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUserAccountStats(clearingHouseUser: User) {
	const freeCollateral = clearingHouseUser.getFreeCollateral();
	logger.info(
		`User free collateral: $${convertToNumber(
			freeCollateral,
			QUOTE_PRECISION
		)}:`
	);

	logger.info(
		`CHUser unrealized funding PnL: ${convertToNumber(
			clearingHouseUser.getUnrealizedFundingPNL(),
			QUOTE_PRECISION
		)}`
	);
	logger.info(
		`CHUser unrealized PnL:         ${convertToNumber(
			clearingHouseUser.getUnrealizedPNL(),
			QUOTE_PRECISION
		)}`
	);
}

const bots: Bot[] = [];
const runBot = async () => {
	const [keypair, wallet] = getWallet();
	const driftPublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);

	const connection = new Connection(endpoint, {
		wsEndpoint: wsEndpoint,
		commitment: stateCommitment,
	});

	let bulkAccountLoader: BulkAccountLoader | undefined;
	let accountSubscription: DriftClientSubscriptionConfig = {
		type: 'websocket',
	};
	let logProviderConfig: LogProviderConfig = {
		type: 'websocket',
	};

	if (!config.global.websocket) {
		bulkAccountLoader = new BulkAccountLoader(
			connection,
			stateCommitment,
			config.global.bulkAccountLoaderPollingInterval
		);
		accountSubscription = {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		};

		logProviderConfig = {
			type: 'polling',
			frequency: config.global.eventSubscriberPollingInterval,
		};
	}

	const driftClient = new DriftClient({
		connection,
		wallet,
		programID: driftPublicKey,
		perpMarketIndexes: PerpMarkets[config.global.driftEnv].map(
			(mkt) => mkt.marketIndex
		),
		spotMarketIndexes: SpotMarkets[config.global.driftEnv].map(
			(mkt) => mkt.marketIndex
		),
		oracleInfos: PerpMarkets[config.global.driftEnv].map((mkt) => {
			return { publicKey: mkt.oracle, source: mkt.oracleSource };
		}),
		opts: {
			commitment: stateCommitment,
			skipPreflight: false,
			preflightCommitment: stateCommitment,
		},
		accountSubscription,
		env: config.global.driftEnv,
		userStats: true,
		txSenderConfig: {
			type: 'retry',
			timeout: 35000,
		},
		activeSubAccountId: config.global.subaccounts[0],
		subAccountIds: config.global.subaccounts,
	});

	const eventSubscriber = new EventSubscriber(connection, driftClient.program, {
		maxTx: 8192,
		maxEventsPerType: 8192,
		orderBy: 'blockchain',
		orderDir: 'desc',
		commitment: stateCommitment,
		logProviderConfig,
	});

	const slotSubscriber = new SlotSubscriber(connection, {});

	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	logger.info(
		`DriftClient ProgramId: ${driftClient.program.programId.toBase58()}`
	);
	logger.info(`Wallet pubkey: ${wallet.publicKey.toBase58()}`);
	logger.info(` . SOL balance: ${lamportsBalance / 10 ** 9}`);

	try {
		const tokenAccount = await getOrCreateAssociatedTokenAccount(
			connection,
			new PublicKey(constants[config.global.driftEnv].USDCMint),
			wallet
		);
		const usdcBalance = await connection.getTokenAccountBalance(tokenAccount);
		logger.info(` . USDC balance: ${usdcBalance.value.uiAmount}`);
	} catch (e) {
		logger.info(`Failed to load USDC token account: ${e}`);
	}

	await driftClient.subscribe();
	driftClient.eventEmitter.on('error', (e) => {
		logger.info('clearing house error');
		logger.error(e);
	});

	eventSubscriber.subscribe();
	await slotSubscriber.subscribe();

	if (!(await driftClient.getUser().exists())) {
		logger.error(`User for ${wallet.publicKey} does not exist`);
		if (config.global.initUser) {
			logger.info(`Creating User for ${wallet.publicKey}`);
			const [txSig] = await driftClient.initializeUserAccount();
			logger.info(`Initialized user account in transaction: ${txSig}`);
		} else {
			throw new Error("Run with '--init-user' flag to initialize a User");
		}
	}

	// subscribe will fail if there is no clearing house user
	const driftUser = driftClient.getUser();
	const driftUserStats = driftClient.getUserStats();
	while (
		!(await driftClient.subscribe()) ||
		!(await driftUser.subscribe()) ||
		!(await driftUserStats.subscribe()) ||
		!eventSubscriber.subscribe()
	) {
		logger.info('waiting to subscribe to DriftClient and User');
		await sleep(1000);
	}
	logger.info(
		`User PublicKey: ${driftUser.getUserAccountPublicKey().toBase58()}`
	);
	await driftClient.fetchAccounts();
	await driftClient.getUser().fetchAccounts();
	await driftClient.forceGetPerpMarketAccount(0);
	await driftClient.forceGetPerpMarketAccount(1);
	await driftClient.forceGetPerpMarketAccount(2);
	await driftClient.forceGetPerpMarketAccount(3);
	await driftClient.forceGetSpotMarketAccount(0);
	await driftClient.forceGetSpotMarketAccount(1);

	printUserAccountStats(driftUser);
	if (config.global.closeOpenPositions) {
		logger.info(`Closing open perp positions`);
		let closedPerps = 0;
		for await (const p of driftUser.getUserAccount().perpPositions) {
			if (p.baseAssetAmount.isZero()) {
				logger.info(`no position on market: ${p.marketIndex}`);
				continue;
			}
			logger.info(`closing position on ${p.marketIndex}`);
			logger.info(` . ${await driftClient.closePosition(p.marketIndex)}`);
			closedPerps++;
		}
		console.log(`Closed ${closedPerps} spot positions`);

		let closedSpots = 0;
		for await (const p of driftUser.getUserAccount().spotPositions) {
			if (p.scaledBalance.isZero()) {
				logger.info(`no position on market: ${p.marketIndex}`);
				continue;
			}
			logger.info(`closing position on ${p.marketIndex}`);
			logger.info(` . ${await driftClient.closePosition(p.marketIndex)}`);
			closedSpots++;
		}
		console.log(`Closed ${closedSpots} spot positions`);
	}

	// check that user has collateral
	const freeCollateral = driftUser.getFreeCollateral();
	if (
		freeCollateral.isZero() &&
		configHasBot(config, 'jitMaker') &&
		!config.global.forceDeposit
	) {
		throw new Error(
			`No collateral in account, collateral is required to run JitMakerBot, run with --force-deposit flag to deposit collateral`
		);
	}
	if (config.global.forceDeposit) {
		logger.info(
			`Depositing (${new BN(
				config.global.forceDeposit
			).toString()} USDC to collateral account)`
		);

		if (config.global.forceDeposit < 0) {
			logger.error(`Deposit amount must be greater than 0`);
			throw new Error('Deposit amount must be greater than 0');
		}

		const mint = SpotMarkets[config.global.driftEnv][0].mint; // TODO: are index 0 always USDC???, support other collaterals

		const ata = await Token.getAssociatedTokenAddress(
			ASSOCIATED_TOKEN_PROGRAM_ID,
			TOKEN_PROGRAM_ID,
			mint,
			wallet.publicKey
		);

		const amount = new BN(config.global.forceDeposit).mul(QUOTE_PRECISION);

		if (config.global.driftEnv === 'devnet') {
			const tokenFaucet = new TokenFaucet(
				connection,
				wallet,
				TOKEN_FAUCET_PROGRAM_ID,
				mint,
				opts
			);
			await tokenFaucet.mintToUser(ata, amount);
		}

		const tx = await driftClient.deposit(
			amount,
			0, // USDC bank
			ata
		);
		logger.info(`Deposit transaction: ${tx}`);
		logger.info(`exiting...run again without --force-deposit flag`);
		return;
	}

	let jitoSearcherClient: SearcherClient | undefined;
	let jitoAuthKeypair: Keypair | undefined;
	if (config.global.useJito) {
		const jitoBlockEngineUrl = config.global.jitoBlockEngineUrl;
		const privateKey = config.global.jitoAuthPrivateKey;
		if (!jitoBlockEngineUrl) {
			throw new Error(
				'Must configure or set JITO_BLOCK_ENGINE_URL environment variable '
			);
		}
		if (!privateKey) {
			throw new Error(
				'Must configure or set JITO_AUTH_PRIVATE_KEY environment variable'
			);
		}
		jitoAuthKeypair = loadKeypair(privateKey);
		jitoSearcherClient = searcherClient(jitoBlockEngineUrl, jitoAuthKeypair);
		jitoSearcherClient.onBundleResult(
			(bundle) => {
				logger.info(`JITO bundle result: ${JSON.stringify(bundle)}`);
			},
			(error) => {
				logger.error(`JITO bundle error: ${error}`);
			}
		);
	}

	/*
	 * Start bots depending on flags enabled
	 */

	if (configHasBot(config, 'filler')) {
		bots.push(
			new FillerBot(
				slotSubscriber,
				bulkAccountLoader,
				driftClient,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.botConfigs.filler,
				jitoSearcherClient,
				jitoAuthKeypair,
				keypair
			)
		);
	}
	if (configHasBot(config, 'spotFiller')) {
		bots.push(
			new SpotFillerBot(
				bulkAccountLoader,
				driftClient,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.botConfigs.spotFiller
			)
		);
	}
	if (configHasBot(config, 'trigger')) {
		bots.push(
			new TriggerBot(
				bulkAccountLoader,
				driftClient,
				slotSubscriber,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.botConfigs.trigger
			)
		);
	}
	if (configHasBot(config, 'jitMaker')) {
		bots.push(
			new JitMakerBot(
				driftClient,
				slotSubscriber,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.botConfigs.trigger
			)
		);
	}

	// Force jito liquidator bot creation
	const liquidator = new LiquidatorBot(
		bulkAccountLoader,
		driftClient,
		{
			rpcEndpoint: endpoint,
			commit: commitHash,
			driftEnv: config.global.driftEnv,
			driftPid: driftPublicKey.toBase58(),
			walletAuthority: wallet.publicKey.toBase58(),
		},
		config.botConfigs.liquidator,
		config.global.subaccounts[0]
	);
	bots.push(liquidator);
	if (configHasBot(config, 'floatingMaker')) {
		bots.push(
			new FloatingPerpMakerBot(
				driftClient,
				slotSubscriber,
				{
					rpcEndpoint: endpoint,
					commit: commitHash,
					driftEnv: config.global.driftEnv,
					driftPid: driftPublicKey.toBase58(),
					walletAuthority: wallet.publicKey.toBase58(),
				},
				config.botConfigs.floatingMaker
			)
		);
	}

	if (configHasBot(config, 'userPnlSettler')) {
		bots.push(
			new UserPnlSettlerBot(
				driftClient,
				PerpMarkets[config.global.driftEnv],
				SpotMarkets[config.global.driftEnv],
				config.botConfigs.userPnlSettler
			)
		);
	}

	if (configHasBot(config, 'ifRevenueSettler')) {
		bots.push(
			new IFRevenueSettlerBot(
				driftClient,
				SpotMarkets[config.global.driftEnv],
				config.botConfigs.ifRevenueSettler
			)
		);
	}

	logger.info(`initializing bots`);
	await Promise.all(bots.map((bot) => bot.init()));

	logger.info(`starting liquidator bot`);

	const blockEngineUrl = process.env.BLOCK_ENGINE_URL || '';
	logger.info(`BLOCK_ENGINE_URL: ${blockEngineUrl}`);

	const authKeypairPath = process.env.AUTH_KEYPAIR_PATH || '';
	logger.info(`AUTH_KEYPAIR_PATH: ${authKeypairPath}`);
	const decodedKey = new Uint8Array(
		JSON.parse(Fs.readFileSync(authKeypairPath).toString()) as number[]
	);
	const keypair = Keypair.fromSecretKey(decodedKey);

	const _accounts = process.env.ACCOUNTS_OF_INTEREST || '';
	logger.info(`ACCOUNTS_OF_INTEREST: ${_accounts}`);
	const accounts = _accounts.split(',').map((acc) => new PublicKey(acc));

	const c = searcherClient(blockEngineUrl, keypair);

	await onPendingTransactions(c, accounts, 5, keypair, connection, liquidator);
	onBundleResult(c);

	if (opts.runOnce) {
		process.exit(0);
	}
}};


function convertToI64(arr: Uint8Array): bigint {
	const buffer = Buffer.from(arr);
	return buffer.readBigInt64LE();
}

function convertToI32(arr: Uint8Array): number {
	const buffer = Buffer.from(arr);
	return buffer.readInt32LE();
}

// Flexible class that takes properties and imbues them
// to the object instance
class Assignable {
	constructor(properties: { [x: string]: any }) {
		Object.keys(properties).map((key) => {
			return ((this as any)[key] = properties[key]);
		});
	}
}

class UpdatePrice extends Assignable {}

export const onPendingTransactions = async (
	c: SearcherClient,
	oracleAccounts: PublicKey[],
	bundleTransactionLimit: number,
	keypair: Keypair,
	conn: Connection,
	liquidatorBot: LiquidatorBot
): Promise<void> => {
	const _tipAccount = (await c.getTipAccounts())[Math.floor(Math.random() * 9)]; // make this rng
	const tipAccount = new PublicKey(_tipAccount);
	// init drift client

	/// Pyth oracle updates from Jito Mempool
	c.onAccountUpdate(
		oracleAccounts,
		async (transactions: Transaction[]) => {
			const pythProgramId = getPythProgramKeyForCluster('mainnet-beta');

			// https://github.com/pyth-network/pyth-client/blob/main/program/rust/src/instruction.rs#L148 UpdPriceArgs
			const updatePriceSchema = new Map([
				[
					UpdatePrice,
					{
						kind: 'struct',
						fields: [
							['version', 'u32'],
							['command', [4]], // i32
							['status', 'u32'],
							['unused', 'u32'],
							['price', [8]], // i64
							['confidence', 'u64'],
							['publishing_slot', 'u64'],
						],
					},
				],
			]);

			for (const tx of transactions) {
				let blockhash: string;
				try {
					const resp = await conn.getRecentBlockhash('processed');
					blockhash = resp.blockhash;
				} catch {
					return;
				}

				const filteredInstructions = tx.instructions.filter((instruction) => {
					if (
						!instruction.programId.equals(pythProgramId) ||
						!oracleAccounts.includes(instruction.keys[1].pubkey) // Watch out for this line - comparison between pubkeys is weird
					) {
						return false;
					}
					let instructionArgs: any;
					try {
						instructionArgs = deserialize(
							updatePriceSchema,
							UpdatePrice,
							instruction.data
						);
					} catch (error) {
						// wrong instruction data format, skip
						return false;
					}
					const command = convertToI32(instructionArgs.command);
					// Only evaluate UpdPrice and UpdPriceNoError ix's
					// https://github.com/pyth-network/pyth-client/blob/main/program/rust/src/instruction.rs#L22 OracleCommand
					return command == 3 || command == 13;
				});

				const bundlePromises: Promise<Transaction[]>[] =
					filteredInstructions.map(async (instruction) => {
						const instructionArgs: any = deserialize(
							updatePriceSchema,
							UpdatePrice,
							instruction.data
						);
						const newPrice = convertToI64(instructionArgs.price);
						const newPriceAsBN = new BN(newPrice.toString()).div(new BN(100));

						const oraclePubkey = instruction.keys[1].pubkey;

						try {
							const bundleTxs = await liquidatorBot.tryLiquidate(
								oraclePubkey,
								newPriceAsBN
							);
							if (bundleTxs.length > 0) {
								bundleTxs.unshift(tx);
							}
							return bundleTxs;
						} catch (e) {
							console.log(e);
							return [];
						}
					});

				const bundles = await Promise.all(bundlePromises);
				for (const bundleTxs of bundles) {
					if (bundleTxs.length == 0) {
						continue;
					}
					for (const bundleTx of bundleTxs) {
						bundleTx.recentBlockhash = blockhash;
						if (bundleTx.signature === null) {
							// Sets fee payer as well
							bundleTx.sign({
								publicKey: keypair.publicKey,
								secretKey: keypair.secretKey,
							});
						}
					}
					const sigBuffer =
						tx.signature === null ? Buffer.from('') : tx.signature;
					logger.info(`backrunning tx ${encode(sigBuffer)}`);
					const b = new Bundle(bundleTxs, bundleTransactionLimit);
					b.attachTip(
						keypair,
						100_000_000,
						tipAccount,
						blockhash,
						1_000_000_000_000 // delete this, make optional?
					);
					c.sendBundle(b);
				}
			}
		},
		(e: Error) => {
			throw e;
		}
	);

	if (config.global.runOnce) {
		process.exit(0);
	}
};

export const onBundleResult = (c: SearcherClient): void => {
	c.onBundleResult(
		(result) => {
			logger.info(`received bundle result: ${result}`);
		},
		(e) => {
			logger.error(`${e}`);
		}
	);
};

async function recursiveTryCatch(f: () => void) {
	try {
		f();
	} catch (e) {
		console.error(e);
		for (const bot of bots) {
			bot.reset();
			await bot.init();
		}
		await sleep(15000);
		await recursiveTryCatch(f);
	}
};

recursiveTryCatch(() => runBot());
