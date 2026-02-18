#!/usr/bin/env node
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration() {
  try {
    console.log('Setting up API security features...');
    
    // Read migration file
    const migrationPath = join(__dirname, '../migrations/add-api-security.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf8');
    
    console.log('Running database migration...');
    
    // Execute migration
    await pool.query(migrationSQL);
    
    console.log('Security tables created successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('1. Restart your backend server');
    console.log('2. Create an API key via POST /api/security/api-keys');
    console.log('3. Use the API key in X-API-Key header for authenticated requests');
    console.log('');
    console.log('See README-SECURITY.md for detailed documentation');
    
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    if (error.code === '42P01') {
      console.error('   Table already exists or migration partially applied.');
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
