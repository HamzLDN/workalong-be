#!/usr/bin/env node
/**
 * Script to clear all staff credentials (username and password_hash)
 * 
 * Usage:
 *   node clear-all-staff-credentials.js
 */

import pool from './db.js';

async function main() {
  try {
    console.log('\nClearing all staff credentials...\n');
    
    const result = await pool.query(
      'UPDATE staff SET username = NULL, password_hash = NULL WHERE username IS NOT NULL'
    );
    
    console.log(`Cleared credentials for ${result.rowCount} staff member(s)\n`);
    
    // List staff without credentials
    const staffResult = await pool.query(
      'SELECT id, name FROM staff ORDER BY id'
    );
    
    if (staffResult.rows.length > 0) {
      console.log('Staff members (now without credentials):');
      staffResult.rows.forEach(staff => {
        console.log(`  ID ${staff.id}: ${staff.name}`);
      });
    }
    
    console.log('\nUse generate-staff-credentials.js to generate credentials for individual staff members\n');
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

