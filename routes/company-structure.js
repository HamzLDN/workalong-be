import express from 'express';
import { pool } from '../lib/db.js';
import { sanitizeString } from '../lib/sanitize.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

function cleanOptionalText(value) {
  if (value == null) return null;
  const trimmed = sanitizeString(String(value)).trim();
  return trimmed || null;
}

async function ensureBranchOwnedByUser(branchId, userId) {
  if (branchId == null || branchId === '') return null;
  const id = parseInt(branchId, 10);
  if (Number.isNaN(id)) {
    const err = new Error('Invalid branch ID');
    err.status = 400;
    throw err;
  }
  const result = await pool.query('SELECT id FROM branches WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  if (result.rows.length === 0) {
    const err = new Error('Branch not found');
    err.status = 404;
    throw err;
  }
  return id;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const [branches, departments] = await Promise.all([
      pool.query(
        `SELECT id, name, address, status, created_at, updated_at
         FROM branches
         WHERE user_id = $1
         ORDER BY status ASC, name ASC`,
        [req.userId]
      ),
      pool.query(
        `SELECT d.id, d.name, d.description, d.status, d.branch_id, b.name AS branch_name,
                d.created_at, d.updated_at
         FROM departments d
         LEFT JOIN branches b ON b.id = d.branch_id
         WHERE d.user_id = $1
         ORDER BY d.status ASC, d.name ASC`,
        [req.userId]
      ),
    ]);

    res.json({ branches: branches.rows, departments: departments.rows });
  } catch (error) {
    console.error('Get company structure error:', error);
    res.status(500).json({ error: 'Failed to load company structure' });
  }
});

router.post('/branches', requireAuth, async (req, res) => {
  try {
    const name = cleanOptionalText(req.body.name);
    if (!name) return res.status(400).json({ error: 'Branch name is required' });
    const address = cleanOptionalText(req.body.address);

    const result = await pool.query(
      `INSERT INTO branches (user_id, name, address)
       VALUES ($1, $2, $3)
       RETURNING id, name, address, status, created_at, updated_at`,
      [req.userId, name, address]
    );
    res.status(201).json({ branch: result.rows[0] });
  } catch (error) {
    console.error('Create branch error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'A branch with this name already exists' });
    }
    res.status(500).json({ error: 'Failed to create branch' });
  }
});

router.put('/branches/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid branch ID' });

    const name = req.body.name !== undefined ? cleanOptionalText(req.body.name) : undefined;
    const address =
      req.body.address !== undefined ? cleanOptionalText(req.body.address) : undefined;
    const status = req.body.status !== undefined ? cleanOptionalText(req.body.status) : undefined;
    if (name === null) return res.status(400).json({ error: 'Branch name cannot be empty' });
    if (status !== undefined && !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid branch status' });
    }

    const result = await pool.query(
      `UPDATE branches
       SET name = COALESCE($1, name),
           address = CASE WHEN $2::text IS NULL THEN address ELSE $2 END,
           status = COALESCE($3, status),
           updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING id, name, address, status, created_at, updated_at`,
      [name, address, status, id, req.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Branch not found' });
    res.json({ branch: result.rows[0] });
  } catch (error) {
    console.error('Update branch error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'A branch with this name already exists' });
    }
    res.status(500).json({ error: 'Failed to update branch' });
  }
});

router.delete('/branches/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid branch ID' });
    const result = await pool.query('DELETE FROM branches WHERE id = $1 AND user_id = $2', [
      id,
      req.userId,
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Branch not found' });
    res.json({ message: 'Branch deleted successfully' });
  } catch (error) {
    console.error('Delete branch error:', error);
    res.status(500).json({ error: 'Failed to delete branch' });
  }
});

router.post('/departments', requireAuth, async (req, res) => {
  try {
    const name = cleanOptionalText(req.body.name);
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    const description = cleanOptionalText(req.body.description);
    const branchId = await ensureBranchOwnedByUser(req.body.branchId, req.userId);

    const result = await pool.query(
      `INSERT INTO departments (user_id, branch_id, name, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, branch_id, name, description, status, created_at, updated_at`,
      [req.userId, branchId, name, description]
    );
    res.status(201).json({ department: result.rows[0] });
  } catch (error) {
    console.error('Create department error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505') {
      return res.status(400).json({ error: 'A department with this name already exists' });
    }
    res.status(500).json({ error: 'Failed to create department' });
  }
});

router.put('/departments/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid department ID' });

    const name = req.body.name !== undefined ? cleanOptionalText(req.body.name) : undefined;
    const description =
      req.body.description !== undefined ? cleanOptionalText(req.body.description) : undefined;
    const branchId =
      req.body.branchId !== undefined
        ? await ensureBranchOwnedByUser(req.body.branchId, req.userId)
        : undefined;
    const status = req.body.status !== undefined ? cleanOptionalText(req.body.status) : undefined;
    if (name === null) return res.status(400).json({ error: 'Department name cannot be empty' });
    if (status !== undefined && !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid department status' });
    }

    const result = await pool.query(
      `UPDATE departments
       SET name = COALESCE($1, name),
           description = CASE WHEN $2::text IS NULL THEN description ELSE $2 END,
           branch_id = CASE WHEN $3::bigint IS NULL THEN branch_id ELSE $3 END,
           status = COALESCE($4, status),
           updated_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING id, branch_id, name, description, status, created_at, updated_at`,
      [name, description, branchId, status, id, req.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Department not found' });
    res.json({ department: result.rows[0] });
  } catch (error) {
    console.error('Update department error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505') {
      return res.status(400).json({ error: 'A department with this name already exists' });
    }
    res.status(500).json({ error: 'Failed to update department' });
  }
});

router.delete('/departments/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid department ID' });
    const result = await pool.query('DELETE FROM departments WHERE id = $1 AND user_id = $2', [
      id,
      req.userId,
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Department not found' });
    res.json({ message: 'Department deleted successfully' });
  } catch (error) {
    console.error('Delete department error:', error);
    res.status(500).json({ error: 'Failed to delete department' });
  }
});

export default router;
