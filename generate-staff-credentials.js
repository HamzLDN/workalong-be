#!/usr/bin/env node
/**
 * Script to check or generate credentials for existing staff members
 * 
 * Usage:
 *   node generate-staff-credentials.js <staff-id> [--generate]
 * 
 * Examples:
 *   node generate-staff-credentials.js 1          # Check credentials for staff ID 1
 *   node generate-staff-credentials.js 1 --generate  # Generate new credentials for staff ID 1
 */

import pool from './db.js';
import { hashPassword } from './auth.js';
import crypto from 'crypto';

const staffId = process.argv[2];
const shouldGenerate = process.argv.includes('--generate');

if (!staffId) {
  console.error('Usage: node generate-staff-credentials.js <staff-id> [--generate]');
  process.exit(1);
}

function getUsernameBase(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim()
    .replace(/\s+/g, '');
  return base || 'user';
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 8; i++) {
    password += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return password;
}

async function main() {
  try {
    // Get staff member
    const staffResult = await pool.query(
      'SELECT * FROM staff WHERE id = $1',
      [staffId]
    );
    
    if (staffResult.rows.length === 0) {
      console.error(`Staff member with ID ${staffId} not found`);
      process.exit(1);
    }
    
    const staff = staffResult.rows[0];
    
    if (shouldGenerate) {
      console.log(`\nGenerating new credentials for: ${staff.name} (ID: ${staff.id})\n`);
      const userId = staff.user_id;
      let code6;
      let attempts = 0;
      while (attempts < 20) {
        code6 = crypto.randomInt(100000, 999999).toString();
        const check = await pool.query(
          `SELECT COUNT(*) FROM staff WHERE user_id = $1 AND username IS NOT NULL
           AND RIGHT(REGEXP_REPLACE(TRIM(username), '[^0-9]', '', 'g'), 6) = $2`,
          [userId, code6]
        );
        if (parseInt(check.rows[0].count, 10) === 0) break;
        attempts++;
      }
      if (attempts >= 20) {
        console.error('Could not generate unique clock-in code');
        process.exit(1);
      }
      // Username = base (from name) + '.' + 6-digit code, e.g. \"dan.411125\"
      const username = `${getUsernameBase(staff.name)}.${code6}`;
      const password = generatePassword();
      const passwordHash = await hashPassword(password);
      await pool.query(
        'UPDATE staff SET username = $1, password_hash = $2 WHERE id = $3',
        [username, passwordHash, staffId]
      );
      console.log('Credentials generated successfully!\n');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('STAFF CREDENTIALS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Name: ${staff.name}`);
      console.log(`Username: ${username}`);
      console.log(`Clock-in code (last 6 digits of username): ${code6}`);
      console.log(`Password: ${password}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      console.log('Save these credentials now - they cannot be retrieved again!');
      
    } else {
      // Check existing credentials
      if (staff.username) {
        console.log(`\nStaff member has credentials:\n`);
        console.log(`Name: ${staff.name}`);
        console.log(`Username: ${staff.username}`);
        console.log(`\nPassword cannot be retrieved (it's hashed for security)`);
        console.log(`   Use --generate to create new credentials\n`);
      } else {
        console.log(`\nStaff member does not have credentials yet\n`);
        console.log(`Name: ${staff.name}`);
        console.log(`\nRun with --generate to create credentials:`);
        console.log(`   node generate-staff-credentials.js ${staffId} --generate\n`);
      }
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

