/**
 * Script to delete test users created during testing
 * Run with: node cleanup-test-users.js
 */

import { pool } from '../lib/db.js';

async function cleanupTestUsers() {
  try {
    console.log('🧹 Cleaning up test users...\n');

    // Find all test users (emails matching test pattern)
    const testUserQuery = `
      SELECT id, email, name, created_at 
      FROM users 
      WHERE email LIKE 'test-%@example.com' 
         OR email LIKE 'test%@example.com'
         OR email LIKE '%test%@example.com'
      ORDER BY created_at DESC
    `;

    const result = await pool.query(testUserQuery);

    if (result.rows.length === 0) {
      console.log('✅ No test users found');
      return;
    }

    console.log(`Found ${result.rows.length} test user(s):\n`);
    result.rows.forEach((user, index) => {
      console.log(`${index + 1}. ${user.email} (ID: ${user.id}, Name: ${user.name})`);
    });

    console.log('\n🗑️  Deleting test users and related data...\n');

    // Delete in order: sessions, staff, shifts, time_entries, etc., then users
    const userIds = result.rows.map(u => u.id);

    // Delete sessions
    const deleteSessions = await pool.query(
      'DELETE FROM sessions WHERE user_id = ANY($1::int[])',
      [userIds]
    );
    console.log(`   Deleted ${deleteSessions.rowCount} session(s)`);

    // Delete API keys
    const deleteApiKeys = await pool.query(
      'DELETE FROM api_keys WHERE user_id = ANY($1::int[])',
      [userIds]
    );
    console.log(`   Deleted ${deleteApiKeys.rowCount} API key(s)`);

    // Delete staff members
    const deleteStaff = await pool.query(
      'DELETE FROM staff WHERE user_id = ANY($1::int[])',
      [userIds]
    );
    console.log(`   Deleted ${deleteStaff.rowCount} staff member(s)`);

    // Delete shifts
    const deleteShifts = await pool.query(
      `DELETE FROM shifts 
       WHERE user_id = ANY($1::int[]) 
          OR staff_id IN (SELECT id FROM staff WHERE user_id = ANY($1::int[]))`,
      [userIds]
    );
    console.log(`   Deleted ${deleteShifts.rowCount} shift(s)`);

    // Delete time entries
    const deleteTimeEntries = await pool.query(
      `DELETE FROM time_entries 
       WHERE user_id = ANY($1::int[]) 
          OR staff_id IN (SELECT id FROM staff WHERE user_id = ANY($1::int[]))`,
      [userIds]
    );
    console.log(`   Deleted ${deleteTimeEntries.rowCount} time entr(ies)`);

    // Delete locations
    const deleteLocations = await pool.query(
      'DELETE FROM locations WHERE user_id = ANY($1::int[])',
      [userIds]
    );
    console.log(`   Deleted ${deleteLocations.rowCount} location(s)`);

    // Delete budgets
    const deleteBudgets = await pool.query(
      'DELETE FROM budgets WHERE user_id = ANY($1::int[])',
      [userIds]
    );
    console.log(`   Deleted ${deleteBudgets.rowCount} budget(s)`);

    // Delete audit logs (if table exists)
    let deleteAuditLogs = { rowCount: 0 };
    try {
      deleteAuditLogs = await pool.query(
        'DELETE FROM audit_logs WHERE user_id = ANY($1::int[])',
        [userIds]
      );
      console.log(`   Deleted ${deleteAuditLogs.rowCount} audit log(s)`);
    } catch (error) {
      if (error.code === '42P01') {
        console.log('   Skipped audit_logs (table does not exist)');
      } else {
        throw error;
      }
    }

    // Delete security events (if table exists)
    let deleteSecurityEvents = { rowCount: 0 };
    try {
      deleteSecurityEvents = await pool.query(
        'DELETE FROM security_events WHERE user_id = ANY($1::int[])',
        [userIds]
      );
      console.log(`   Deleted ${deleteSecurityEvents.rowCount} security event(s)`);
    } catch (error) {
      if (error.code === '42P01') {
        console.log('   Skipped security_events (table does not exist)');
      } else {
        throw error;
      }
    }

    // Finally, delete users
    const deleteUsers = await pool.query(
      'DELETE FROM users WHERE id = ANY($1::int[])',
      [userIds]
    );
    console.log(`   Deleted ${deleteUsers.rowCount} user(s)`);

    console.log('\n✅ Cleanup complete!');
    console.log(`\nSummary:`);
    console.log(`   - Users deleted: ${deleteUsers.rowCount}`);
    console.log(`   - Sessions deleted: ${deleteSessions.rowCount}`);
    console.log(`   - Staff deleted: ${deleteStaff.rowCount}`);
    console.log(`   - Shifts deleted: ${deleteShifts.rowCount}`);
    console.log(`   - Time entries deleted: ${deleteTimeEntries.rowCount}`);
    console.log(`   - Locations deleted: ${deleteLocations.rowCount}`);
    console.log(`   - Budgets deleted: ${deleteBudgets.rowCount}`);
    console.log(`   - Audit logs deleted: ${deleteAuditLogs.rowCount}`);
    console.log(`   - Security events deleted: ${deleteSecurityEvents.rowCount}`);

  } catch (error) {
    console.error('❌ Error cleaning up test users:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run cleanup
cleanupTestUsers()
  .then(() => {
    console.log('\n✨ Done!');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

