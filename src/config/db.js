import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  try {
    if (!uri) {
      throw new Error('MONGODB_URI is required');
    }

    const options = {};
    const dbName = process.env.MONGODB_DB_NAME;
    if (dbName) {
      options.dbName = dbName;
    }

    const conn = await mongoose.connect(uri, options);
    const db = dbName || conn.connection.db?.databaseName || '(from URI)';
    logger.info(`MongoDB connected: ${conn.connection.host}, database: ${db}`);
  } catch (error) {
    let msg = error.message;
    if (uri && /ENOTFOUND|querySrv/i.test(msg) && /mongodb\.net/i.test(uri)) {
      msg += ' — Check MONGODB_URI: use your real Atlas hostname (not the example cluster.mongodb.net placeholder), or run MongoDB locally.';
    }
    logger.error(`MongoDB connection error: ${msg}`);
    process.exit(1);
  }
};

export default connectDB;
