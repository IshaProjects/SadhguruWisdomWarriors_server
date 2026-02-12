import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI;
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
    logger.error(`MongoDB connection error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
