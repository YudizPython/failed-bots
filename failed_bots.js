require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const { MongoClient } = require('mongodb');

const CONFIG = {
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    MONGODB_URI: process.env.MONGODB_URI,
    DB_NAME: process.env.DB_NAME,
    BOTS_COLLECTION: process.env.BOTS_COLLECTION,
    FAILED_TX_COLLECTION: process.env.FAILED_TX_COLLECTION,
    EXTENDED_BOT_THRESHOLD: 40,
    NORMAL_BOT_THRESHOLD: 20,
    BATCH_SIZE: 50,

    MONGO_OPTIONS: {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 20000,
        socketTimeoutMS: 45000,
        maxPoolSize: 50,
        minPoolSize: 0,
        retryWrites: true,
        retryReads: true,
        directConnection: false,
    }
};

let mongoClient = null;
let solanaConnection = null;

// Initialize connections
async function initializeConnections() {
    try {
        if (!mongoClient || !mongoClient.topology || !mongoClient.topology.isConnected()) {
            mongoClient = new MongoClient(CONFIG.MONGODB_URI, {
                ...CONFIG.MONGO_OPTIONS,
                monitorCommands: true
            });

            // Add connection event listeners
            mongoClient.on('serverDescriptionChanged', event => {
                console.log('Server description changed:', event);
            });

            mongoClient.on('error', error => {
                console.error('MongoDB connection error:', error);
            });

            await mongoClient.connect();
            console.log('MongoDB connection established successfully');
        }

        // Test the connection
        await mongoClient.db('admin').command({ ping: 1 });
        console.log("MongoDB connection validated");

        if (!solanaConnection) {
            solanaConnection = new Connection(CONFIG.SOLANA_RPC_URL);
        }

        return {
            mongoClient,
            solanaConnection
        };
    } catch (error) {
        console.error('Connection initialization error:', error);
        if (mongoClient) {
            await mongoClient.close();
            mongoClient = null;
        }
        throw error;
    }
}

class TransactionProcessor {
    constructor(solanaConnection, mongoClient) {
        this.solanaConnection = solanaConnection;
        this.mongoClient = mongoClient;
        this.db = this.mongoClient.db(CONFIG.DB_NAME);
    }

    async getRecentTransactions(address) {
        try {
            const publicKey = new PublicKey(address);
            const signatures = await this.solanaConnection.getSignaturesForAddress(publicKey, {
                limit: 1,
            });

            if (signatures.length === 0) {
                return { tx: { dateString: new Date().toISOString() }, balance: 0 };
            }

            const [transaction] = await Promise.all(
                signatures.map(async (signatureInfo) => {
                    const tx = await this.solanaConnection.getTransaction(
                        signatureInfo.signature,
                        {
                            commitment: 'finalized',
                            maxSupportedTransactionVersion: 1,
                        },
                    );
                    return {
                        blockTime: tx.blockTime,
                        dateString: new Date(tx.blockTime * 1000).toISOString(),
                    };
                }),
            );

            const balance = await this.solanaConnection.getBalance(publicKey);
            return { tx: transaction, balance };
        } catch (error) {
            console.error(`Error fetching transactions for address ${address}:`, error);
            throw error;
        }
    }

    calculateTimeDifference(dateString) {
        const currentTime = new Date();
        const transactionTime = new Date(dateString);
        return (currentTime - transactionTime) / (1000 * 60);
    }

    async checkExistingTransaction(address, botId) {
        try {
            const existingTransaction = await this.db.collection(CONFIG.FAILED_TX_COLLECTION)
                .findOne({
                    address: address,
                    'botId.oid': botId.oid
                });
            return existingTransaction !== null;
        } catch (error) {
            console.error('Error checking existing transaction:', error);
            return false;
        }
    }

    async processBatch(addresses, timeThreshold) {
        const failedAddresses = [];
        
        await Promise.all(
            addresses.map(async (item) => {
                try {
                    // Check if transaction already exists
                    const exists = await this.checkExistingTransaction(item.addresses.value, item.botId);
                    if (exists) {
                        console.log('Skipping existing transaction for address:', item.addresses.value);
                        return;
                    }

                    const result = await this.getRecentTransactions(item.addresses.value);
                    const timeDifference = this.calculateTimeDifference(result.tx.dateString);

                    if (timeDifference > timeThreshold && result.balance !== 0) {
                        const failedTx = {
                            address: item.addresses.value,
                            transactionDate: result.tx.dateString,
                            balance: result.balance,
                            botId: item.botId,
                            createdAt: new Date(),
                            status: false,
                            botType: item.isExtendedBot ? 'extended' : 'normal',
			    reason: ""
                        };

                        // Store in MongoDB immediately
                        await this.db.collection(CONFIG.FAILED_TX_COLLECTION).insertOne(failedTx);
                        failedAddresses.push(failedTx);

                        console.log('Failed transaction stored:', 
                            item.addresses.value,
                            'Time difference:', timeDifference,
                            'Balance:', result.balance,
                            'botId:', item.botId,
                            'botType:', failedTx.botType
                        );
                    }
                } catch (error) {
                    console.error('Error processing address:', item.addresses.value, error);
                }
            })
        );

        return failedAddresses;
    }

    async processAddresses(documents, timeThreshold, isExtendedBot) {
        const allAddresses = documents.flatMap(doc => 
            Object.entries(doc)
                .filter(([key]) => key.startsWith('sAddress'))
                .map(([key, value]) => ({
                    addresses: { key, value },
                    botId: doc['_id'],
                    isExtendedBot
                }))
        );

        const results = [];
        // Process in batches
        for (let i = 0; i < allAddresses.length; i += CONFIG.BATCH_SIZE) {
            const batch = allAddresses.slice(i, i + CONFIG.BATCH_SIZE);
            const batchResults = await this.processBatch(batch, timeThreshold);
            results.push(...batchResults);
        }

        return results;
    }
}

// Main execution function
async function main() {
    try {
        const { mongoClient: client, solanaConnection } = await initializeConnections();
        const processor = new TransactionProcessor(solanaConnection, client);
        const db = client.db(CONFIG.DB_NAME);

        const extendedBots = await db.collection(CONFIG.BOTS_COLLECTION)
            .find({ eStatus: "2", bIsExtendedBot: true }).toArray();
        const extendedResults = await processor.processAddresses(
            extendedBots,
            CONFIG.EXTENDED_BOT_THRESHOLD,
            true
        );

        const normalBots = await db.collection(CONFIG.BOTS_COLLECTION)
            .find({ eStatus: "2", bIsExtendedBot: false }).toArray();
        const normalResults = await processor.processAddresses(
            normalBots,
            CONFIG.NORMAL_BOT_THRESHOLD,
            false
        );

        console.log('Extended Bot Results:', extendedResults);
        console.log('Normal Bot Results:', normalResults);

    } catch (error) {
        console.error('Execution error:', error);
    } finally {
        if (mongoClient) {
            await mongoClient.close();
        }
    }
}

main();
