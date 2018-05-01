// https://stackoverflow.com/questions/17554688/has-anyone-tried-using-the-uv-threadpool-size-environment-variable
process.env.UV_THREADPOOL_SIZE = 100;

const Nimiq = require('@nimiq/core');
const argv = require('minimist')(process.argv.slice(2));
const readFromFile = require('./src/Config.js');
const readlineSync = require('readline-sync');
const os = require('os');
var fs = require('fs');

const START = Date.now();
const TAG = 'SushiPool';
const $ = {};
const defaultConfigFile = 'sushipool.conf'
const poolHostMain = 'eu.sushipool.com';
const poolHostTest = 'eu-test.sushipool.com';
const poolPort = 443;

Nimiq.Log.instance.level = 'info';

let config = readFromFile(argv.config);
if (!config) {
    Nimiq.Log.i(TAG, `Trying ${defaultConfigFile}`);
    config = readFromFile(defaultConfigFile);
    if (!config) {
        Nimiq.Log.i(TAG, 'No 🍣 configuration file found. Please answer the following questions:');

        const askAddress = readlineSync.question('- Enter NIMIQ address to mine to: ');

        const maxThreads = os.cpus().length;
        let askNumThreads = maxThreads;
        if (readlineSync.keyInYN(`- Use maximum number of threads (${maxThreads})? `)) {
            // Y, do nothing
        } else {
            // ask for numThreads
            askNumThreads = readlineSync.question('- Enter the number of threads: ');
        }

        let askPoolHost = 'auto';
        if (readlineSync.keyInYN(`- Use default pool server (${poolHostMain})? `)) {
            // Y, do nothing
        } else {
            // ask for numThreads
            askPoolHost = readlineSync.question('- Enter the pool host: ');
        }

        const ask = {
            address: askAddress,
            threads: askNumThreads,
            server: askPoolHost
        };
        const data = JSON.stringify(ask, null, 4);
        fs.writeFileSync(defaultConfigFile, data);
        config = readFromFile(defaultConfigFile);
    }
}

let poolHost;
if (!argv.hasOwnProperty('test')){
    poolHost = poolHostMain;
} else {
    Nimiq.Log.w('----- YOU ARE CONNECTING TO TESTNET -----');
    poolHost = poolHostTest;
    config.network = 'test';
}

config = Object.assign(config, argv);
config.poolMining.enabled = true;
config.poolMining.host = poolHost;
config.poolMining.port = poolPort;
config.miner.enabled = true;
if(config.hasOwnProperty('threads')){
    config.miner.threads = config.threads;
    delete config.threads;
}
if (typeof config.miner.threads !== 'number' && config.miner.threads !== 'auto') {
    Nimiq.Log.e(TAG, 'Specify a valid thread number');
    process.exit(1);
}

function humanHashes(bytes) {
    var thresh = 1000;
    if(Math.abs(bytes) < thresh) {
        return bytes + ' H/s';
    }
    var units = ['kH/s','MH/s','GH/s','TH/s','PH/s','EH/s','ZH/s','YH/s'];
    var u = -1;
    do {
        bytes /= thresh;
        ++u;
    } while(Math.abs(bytes) >= thresh && u < units.length - 1);
    return bytes.toFixed(1)+' '+units[u];
}
(async () => {
    Nimiq.Log.i(TAG, `SushiPool Miner starting.`);
    Nimiq.Log.i(TAG, `- network          = ${config.network}`);
    Nimiq.Log.i(TAG, `- no. of threads   = ${config.miner.threads}`);
    Nimiq.Log.i(TAG, `- pool server      = ${config.poolMining.host}:${config.poolMining.port}`);
    Nimiq.Log.i(TAG, `- address          = ${config.address}`);
    Nimiq.Log.i(TAG, `Please wait while we establish consensus.`);

    Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS[config.network]);
    const networkConfig = new Nimiq.DumbNetworkConfig()
    $.consensus = await Nimiq.Consensus.light(networkConfig);
    $.blockchain = $.consensus.blockchain;
    $.accounts = $.blockchain.accounts;
    $.mempool = $.consensus.mempool;
    $.network = $.consensus.network;

    $.walletStore = await new Nimiq.WalletStore();
    if (!config.address) {
        // Load or create default wallet.
        $.wallet = await $.walletStore.getDefault();
    } else {
        const address = Nimiq.Address.fromUserFriendlyAddress(config.address);
        $.wallet = {address: address};
        // Check if we have a full wallet in store.
        const wallet = await $.walletStore.get(address);
        if (wallet) {
            $.wallet = wallet;
            await $.walletStore.setDefault(wallet.address);
        }
    }

    const account = await $.accounts.get($.wallet.address);
    Nimiq.Log.i(TAG, `Wallet initialized for address ${$.wallet.address.toUserFriendlyAddress()}.`
        + ` Balance: ${Nimiq.Policy.satoshisToCoins(account.balance)} NIM`);
    Nimiq.Log.i(TAG, `Blockchain state: height=${$.blockchain.height}, headHash=${$.blockchain.headHash}`);

    // connect to pool
    const deviceId = Nimiq.BasePoolMiner.generateDeviceId(networkConfig);
    $.miner = new Nimiq.SmartPoolMiner($.blockchain, $.accounts, $.mempool, $.network.time, $.wallet.address, deviceId);

    $.consensus.on('established', () => {
        Nimiq.Log.i(TAG, `Connecting to pool ${config.poolMining.host} using device id ${deviceId} as a smart client.`);
        $.miner.connect(config.poolMining.host, config.poolMining.port);
    });

    $.blockchain.on('head-changed', (head) => {
        if ($.consensus.established || head.height % 100 === 0) {
            Nimiq.Log.i(TAG, `Now at block: ${head.height}`);
        }
    });

    $.network.on('peer-joined', (peer) => {
        Nimiq.Log.i(TAG, `Connected to ${peer.peerAddress.toString()}`);
    });

    $.network.on('peer-left', (peer) => {
        Nimiq.Log.i(TAG, `Disconnected from ${peer.peerAddress.toString()}`);
    });

    $.network.connect();
    $.consensus.on('established', () => $.miner.startWork());
    $.consensus.on('lost', () => $.miner.stopWork());
    if (typeof config.miner.threads === 'number') {
        $.miner.threads = config.miner.threads;
    }

    $.consensus.on('established', () => {
        Nimiq.Log.i(TAG, `Blockchain light-consensus established in ${(Date.now() - START) / 1000}s.`);
        Nimiq.Log.i(TAG, `Current state: height=${$.blockchain.height}, totalWork=${$.blockchain.totalWork}, headHash=${$.blockchain.headHash}`);
    });

    $.miner.on('block-mined', (block) => {
        Nimiq.Log.i(TAG, `Block mined: #${block.header.height}, hash=${block.header.hash()}`);
    });

    // Output regular statistics
    const hashrates = [];
    const outputInterval = 5;
    $.miner.on('hashrate-changed', async (hashrate) => {
        hashrates.push(hashrate);

        if (hashrates.length >= outputInterval) {
            const account = await $.accounts.get($.wallet.address);
            const sum = hashrates.reduce((acc, val) => acc + val, 0);
            Nimiq.Log.i(TAG, `Hashrate: ${humanHashes((sum / hashrates.length).toFixed(2).padStart(7))}`
                + ` - Balance: ${Nimiq.Policy.satoshisToCoins(account.balance)} NIM`
                + ` - Mempool: ${$.mempool.getTransactions().length} tx`);
            hashrates.length = 0;
        }
    });

})().catch(e => {
    console.error(e);
    process.exit(1);
});
