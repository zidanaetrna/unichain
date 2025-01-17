import fs from 'fs';
import WebSocket from 'ws';
import axios from 'axios';
import readline from 'readline';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { v4 as uuidv4 } from 'uuid';


let dataStore = {};
try {
  dataStore = JSON.parse(fs.readFileSync('data.json', 'utf8'));
} catch (err) {
  console.log('No existing data store found, creating a new data.json.');
}

const gpuList = JSON.parse(fs.readFileSync('src/gpu.json', 'utf8'));

function getOrAssignResources(address) {
  if (!dataStore[address].gpu || !dataStore[address].storage) {
    const randomGPU = gpuList[Math.floor(Math.random() * gpuList.length)];
    const randomStorage = (Math.random() * 500).toFixed(2);

    dataStore[address].gpu = randomGPU;
    dataStore[address].storage = randomStorage;

    try {
      fs.writeFileSync('data.json', JSON.stringify(dataStore, null, 2));
    } catch (error) {
      console.error('Error writing GPU/storage to data.json:', error.message);
    }
  }
}

function displayHeader() {
  const width = process.stdout.columns;
  const headerLines = [
    "<|============================================|>",
    " OpenLedger Bot ",
    " github.com/recitativonika ",
    " Republished by Hanami ",
    "<|============================================|>"
  ];
  headerLines.forEach(line => {
    console.log(`\x1b[36m${line.padStart((width + line.length) / 2)}\x1b[0m`);
  });
}

let wallets = [];
try {
  wallets = fs.readFileSync('account.txt', 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
} catch (err) {
  console.error('Error reading account.txt:', err.message);
  process.exit(1);
}

let proxies = [];
try {
  proxies = fs.readFileSync('proxy.txt', 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
} catch (error) {
  console.error('Error reading proxy.txt:', error.message);
}

if (proxies.length > 0 && proxies.length < wallets.length) {
  console.error('The number of proxies is less than the number of wallets. Please provide enough proxies.');
  process.exit(1);
}

const accountIDs = {};

async function askUseProxy() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    function ask() {
      rl.question('Do you want to use a proxy? (y/n): ', (answer) => {
        if (answer.toLowerCase() === 'y') {
          resolve(true);
          rl.close();
        } else if (answer.toLowerCase() === 'n') {
          resolve(false);
          rl.close();
        } else {
          console.log('Please answer with y or n.');
          ask();
        }
      });
    }
    ask();
  });
}

async function generateTokenForAddress(address, agent, delay = 60000) {
  let attempt = 1;
  while (true) {
    try {
      const result = await axios.post(
        'https://apitn.openledger.xyz/api/v1/auth/generate_token',
        { address },
        {
          headers: { 'Content-Type': 'application/json' },
          httpsAgent: agent
        }
      );
      return result.data?.data?.token || null;
    } catch (error) {
      console.error(`Error generating token for wallet ${address}, attempt ${attempt}:`, error.message);
      console.log(`Retrying token generation for wallet ${address} in ${delay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

async function getOrCreateWalletData(address, agent) {
  if (!dataStore[address]) {
    dataStore[address] = {
      address,
      workerID: Buffer.from(address).toString('base64'),
      id: uuidv4(),
      token: null,
      gpu: null,
      storage: null
    };
  }

  if (!dataStore[address].token) {
    const token = await generateTokenForAddress(address, agent);
    if (!token) {
      console.log('Could not generate token. Will skip this wallet for now.');
      return null;
    }
    dataStore[address].token = token;
    try {
      fs.writeFileSync('data.json', JSON.stringify(dataStore, null, 2));
    } catch (error) {
      console.error('Error writing to data.json:', error.message);
    }
  }

  return dataStore[address];
}

async function getAccountID(token, address, index, useProxy, delay = 60000) {
  const proxyUrl = proxies.length > 0 ? proxies[index % proxies.length] : '';
  const agent = useProxy && proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const proxyText = useProxy && proxyUrl ? proxyUrl : 'False';

  let attempt = 1;
  while (true) {
    try {
      const response = await axios.get('https://apitn.openledger.xyz/api/v1/users/me', {
        headers: { 'Authorization': `Bearer ${token}` },
        httpsAgent: agent
      });
      const acctID = response.data.data.id;
      accountIDs[address] = acctID;
      console.log(`\x1b[33m[${index + 1}]\x1b[0m AccountID \x1b[36m${acctID}\x1b[0m, Proxy: \x1b[36m${proxyText}\x1b[0m`);
      return;
    } catch (error) {
      console.error(`\x1b[33m[${index + 1}]\x1b[0m Error getting accountID for wallet ${address}, attempt ${attempt}:`, error.message);
      console.log(`\x1b[33m[${index + 1}]\x1b[0m Retrying in ${delay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

async function getAccountDetails(token, address, index, useProxy, retries = 3, delay = 60000) {
  const proxyUrl = proxies.length > 0 ? proxies[index % proxies.length] : '';
  const agent = useProxy && proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const proxyText = useProxy && proxyUrl ? proxyUrl : 'False';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const rewardRealtimeResponse = await axios.get('https://rewardstn.openledger.xyz/api/v1/reward_realtime', {
        headers: { 'Authorization': `Bearer ${token}` },
        httpsAgent: agent
      });
      const rewardHistoryResponse = await axios.get('https://rewardstn.openledger.xyz/api/v1/reward_history', {
        headers: { 'Authorization': `Bearer ${token}` },
        httpsAgent: agent
      });
      const rewardResponse = await axios.get('https://rewardstn.openledger.xyz/api/v1/reward', {
        headers: { 'Authorization': `Bearer ${token}` },
        httpsAgent: agent
      });

      const totalHeartbeats = parseInt(rewardRealtimeResponse.data.data[0]?.total_heartbeats || 0, 10);
      const totalPointFromReward = parseFloat(rewardResponse.data.data?.totalPoint || 0);
      const epochName = rewardResponse.data.data?.name || '';

      const total = totalHeartbeats + totalPointFromReward;

      console.log(
          `\x1b[33m[${index + 1}]\x1b[0m Wallet \x1b[36m${address}\x1b[0m, ` +
          `AccountID \x1b[36m${accountIDs[address]}\x1b[0m, Total Heartbeat \x1b[32m${totalHeartbeats}\x1b[0m, ` +
          `Total Points \x1b[32m${total.toFixed(2)}\x1b[0m (\x1b[33m${epochName}\x1b[0m), ` +
          `Proxy: \x1b[36m${proxyText}\x1b[0m`
      );
      return;
    } catch (error) {
      console.error(`Error getting account details for wallet ${address}, attempt ${attempt}:`, error.message);
      if (attempt < retries) {
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('All retry attempts failed for account details.');
      }
    }
  }
}

async function checkAndClaimReward(token, address, index, useProxy, retries = 3, delay = 60000) {
  const proxyUrl = proxies.length > 0 ? proxies[index % proxies.length] : '';
  const agent = useProxy && proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const claimDetailsResponse = await axios.get('https://rewardstn.openledger.xyz/api/v1/claim_details', {
        headers: { 'Authorization': `Bearer ${token}` },
        httpsAgent: agent
      });

      const claimed = claimDetailsResponse.data.data?.claimed;
      if (!claimed) {
        const claimRewardResponse = await axios.get('https://rewardstn.openledger.xyz/api/v1/claim_reward', {
          headers: { 'Authorization': `Bearer ${token}` },
          httpsAgent: agent
        });

        if (claimRewardResponse.data.status === 'SUCCESS') {
          console.log(
              `\x1b[33m[${index + 1}]\x1b[0m Wallet \x1b[36m${address}\x1b[0m, ` +
              `AccountID \x1b[36m${accountIDs[address]}\x1b[0m \x1b[32mClaimed daily reward successfully!\x1b[0m`
          );
        }
      }
      return;
    } catch (error) {
      console.error(`Error claiming reward for wallet ${address}, attempt ${attempt}:`, error.message);
      if (attempt < retries) {
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('All retry attempts failed for claiming reward.');
      }
    }
  }
}

async function checkAndClaimRewardsPeriodically(useProxy) {
  const promises = wallets.map(async (address, index) => {
    const { token } = dataStore[address] || {};
    if (!token) return;
    await checkAndClaimReward(token, address, index, useProxy);
  });
  await Promise.all(promises);

  setInterval(async () => {
    const promises = wallets.map(async (address, idx) => {
      const { token } = dataStore[address] || {};
      if (!token) return;
      await checkAndClaimReward(token, address, idx, useProxy);
    });
    await Promise.all(promises);
  }, 12 * 60 * 60 * 1000);
}

function connectWebSocket({ token, workerID, id, address }, index, useProxy) {
  const proxyUrl = proxies.length > 0 ? proxies[index % proxies.length] : '';
  const agent = useProxy && proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const wsUrl = `wss://apitn.openledger.xyz/ws/v1/orch?authToken=${token}`;
  const wsOptions = {
    agent,
    headers: {
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      'Cache-Control': 'no-cache',
      'Connection': 'Upgrade',
      'Host': 'apitn.openledger.xyz',
      'Origin': 'chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc',
      'Pragma': 'no-cache',
      'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
      'Sec-WebSocket-Key': '0iJKzoEtY2vsWuXjR8ZSng==',
      'Sec-WebSocket-Version': '13',
      'Upgrade': 'websocket',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    }
  };
  const proxyText = useProxy && proxyUrl ? proxyUrl : 'False';

  const ws = new WebSocket(wsUrl, wsOptions);
  let heartbeatInterval;

  function sendHeartbeat() {
    getOrAssignResources(address);
    const assignedGPU = dataStore[address].gpu || '';
    const assignedStorage = dataStore[address].storage || '';
    const heartbeatMessage = {
      message: {
        Worker: {
          Identity: workerID,
          ownerAddress: address,
          type: 'LWEXT',
          Host: 'chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc'
        },
        Capacity: {
          AvailableMemory: (Math.random() * 32).toFixed(2),
          AvailableStorage: assignedStorage,
          AvailableGPU: assignedGPU,
          AvailableModels: []
        }
      },
      msgType: 'HEARTBEAT',
      workerType: 'LWEXT',
      workerID
    };
    console.log(
        `\x1b[33m[${index + 1}]\x1b[0m AccountID \x1b[36m${accountIDs[address]}\x1b[0m: ` +
        `Sending heartbeat for workerID: \x1b[33m${workerID}\x1b[0m, Proxy: \x1b[36m${proxyText}\x1b[0m`
    );
    ws.send(JSON.stringify(heartbeatMessage));
  }

  ws.on('open', () => {
    console.log(
        `\x1b[33m[${index + 1}]\x1b[0m AccountID \x1b[36m${accountIDs[address]}\x1b[0m: ` +
        `Connected to WebSocket for workerID: \x1b[33m${workerID}\x1b[0m, Proxy: \x1b[36m${proxyText}\x1b[0m`
    );

    const registerMessage = {
      workerID,
      msgType: 'REGISTER',
      workerType: 'LWEXT',
      message: {
        id,
        type: 'REGISTER',
        worker: {
          host: 'chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc',
          identity: workerID,
          ownerAddress: address,
          type: 'LWEXT'
        }
      }
    };
    ws.send(JSON.stringify(registerMessage));

    heartbeatInterval = setInterval(sendHeartbeat, 30000);
  });

  ws.on('message', data => {
    console.log(
        `\x1b[33m[${index + 1}]\x1b[0m AccountID \x1b[36m${accountIDs[address]}\x1b[0m: ` +
        `Received for workerID \x1b[33m${workerID}\x1b[0m: ${data}, Proxy: \x1b[36m${proxyText}\x1b[0m`
    );
  });

  ws.on('error', err => {
    console.error(`\x1b[33m[${index + 1}]\x1b[0m AccountID \x1b[36m${accountIDs[address]}\x1b[0m: ` +
        `WebSocket error for workerID \x1b[33m${workerID}\x1b[0m:`, err);
  });

  ws.on('close', () => {
    console.log(
        `\x1b[33m[${index + 1}]\x1b[0m AccountID \x1b[36m${accountIDs[address]}\x1b[0m: ` +
        `WebSocket connection closed for workerID \x1b[33m${workerID}\x1b[0m, Proxy: \x1b[36m${proxyText}\x1b[0m`
    );
    clearInterval(heartbeatInterval);

    setTimeout(() => {
      console.log(
          `\x1b[33m[${index + 1}]\x1b[0m AccountID \x1b[36m${accountIDs[address]}\x1b[0m: ` +
          `Reconnecting WebSocket for workerID: \x1b[33m${workerID}\x1b[0m, Proxy: \x1b[36m${proxyText}\x1b[0m`
      );
      connectWebSocket({ token, workerID, id, address }, index, useProxy);
    }, 30000);
  });
}

async function claimMedals(token, address, index, useProxy) {
  const proxyUrl = proxies.length > 0 ? proxies[index % proxies.length] : '';
  const agent = useProxy && proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  for (let tierId = 1; tierId <= 8; tierId++) {
    try {
      const response = await axios.put(
        'https://rewardstn.openledger.xyz/api/v1/claim_tier',
        { tierId },
        {
          headers: { 'Authorization': `Bearer ${token}` },
          httpsAgent: agent
        }
      );

      if (response.data.status === 'SUCCESS' && response.data.data === true) {
        console.log(
          `\x1b[33m[${index + 1}]\x1b[0m Wallet \x1b[36m${address}\x1b[0m: ` +
          `Successfully claimed medal for tier \x1b[32m${tierId}\x1b[0m`
        );
      }
    } catch (error) {

    }
  }
}

async function processRequests(useProxy) {
  const promises = wallets.map(async (address, index) => {
    const proxyUrl = proxies.length > 0 ? proxies[index % proxies.length] : '';
    const agent = useProxy && proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const record = await getOrCreateWalletData(address, agent);
    if (!record || !record.token) {
      console.log(`Skipping wallet ${address} due to missing token.`);
      return;
    }

    await getAccountID(record.token, address, index, useProxy);
    if (!accountIDs[address]) {
      console.log(`Wallet ${address} has no valid accountID, skipping further steps...`);
      return;
    }

    connectWebSocket({
      token: record.token,
      workerID: record.workerID,
      id: record.id,
      address
    }, index, useProxy);

    await Promise.all([
      claimMedals(record.token, address, index, useProxy),
      checkAndClaimReward(record.token, address, index, useProxy),
      getAccountDetails(record.token, address, index, useProxy)
    ]);

    getOrAssignResources(address);
  });

  await Promise.all(promises);
}
async function claimMedalsPeriodically(useProxy) {
  setInterval(async () => {
    const promises = wallets.map(async (address, index) => {
      const { token } = dataStore[address] || {};
      if (!token) return;
      await claimMedals(token, address, index, useProxy);
    });
    await Promise.all(promises);
  }, 12 * 60 * 60 * 1000);
}

async function updateAccountDetailsPeriodically(useProxy) {
  setInterval(async () => {
    const promises = wallets.map(async (address, index) => {
      const { token } = dataStore[address] || {};
      if (!token) return;
      await getAccountDetails(token, address, index, useProxy);
    });
    await Promise.all(promises);
  }, 5 * 60 * 1000);
}

(async () => {
  displayHeader();

  const useProxy = await askUseProxy();
  await checkAndClaimRewardsPeriodically(useProxy);
  await processRequests(useProxy);
  updateAccountDetailsPeriodically(useProxy);
  claimMedalsPeriodically(useProxy);
})();