import { pool } from '../lib/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  try {
    console.log('Running migration: Add subscription_discount_percent column...');
    
    // Read the SQL file
    const sqlPath = path.join(__dirname, 'add-discount-percent-column.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Execute the migration
    await pool.query(sql);
    
    console.log('✅ Migration completed successfully!');
    console.log('The subscription_discount_percent column has been added to the users table.');
    
    // Verify the column exists
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'users' 
      AND column_name = 'subscription_discount_percent'
    `);
    
    if (result.rows.length > 0) {
      console.log('\n✅ Verification: Column exists');
      console.log(`   Type: ${result.rows[0].data_type}`);
      console.log(`   Nullable: ${result.rows[0].is_nullable}`);
    } else {
      console.log('\n⚠️  Warning: Column not found after migration');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    if (error.code === '42703') {
      console.error('   This might mean the column already exists or there was an issue.');
    }
    process.exit(1);
  }
}

runMigration();


