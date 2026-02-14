import express from 'express';
import {
  getBudgets,
  getActiveBudget,
  createBudget,
  updateBudget,
  getBudgetStats
} from '../staff.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const budgets = await getBudgets(req.userId);
    res.json({ budgets });
  } catch (error) {
    console.error('Get budgets error:', error);
    res.status(500).json({ error: 'Failed to get budgets' });
  }
});

router.get('/active', requireAuth, async (req, res) => {
  try {
    const budget = await getActiveBudget(req.userId);
    res.json({ budget });
  } catch (error) {
    console.error('Get active budget error:', error);
    res.status(500).json({ error: 'Failed to get active budget' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'User authentication required' });
    }
    const { name, monthlyBudget, startDate, endDate } = req.body;
    if (!name || monthlyBudget === undefined || monthlyBudget === null || !startDate) {
      return res.status(400).json({ error: 'Name, monthly budget, and start date are required' });
    }
    const budgetAmount = parseFloat(monthlyBudget);
    if (isNaN(budgetAmount) || budgetAmount < 0) {
      return res.status(400).json({ error: 'Monthly budget must be a positive number' });
    }
    const budget = await createBudget(req.userId, { name, monthlyBudget: budgetAmount, startDate, endDate });
    res.status(201).json({ message: 'Budget created successfully', budget });
  } catch (error) {
    console.error('Create budget error:', error);
    if (error.code === '23505') {
      res.status(400).json({ error: 'A budget with this name already exists' });
    } else if (error.code === '23503') {
      res.status(400).json({ error: 'Invalid user or reference' });
    } else {
      res.status(500).json({ error: error.message || 'Failed to create budget' });
    }
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'User authentication required' });
    }
    const budgetId = req.params.id;
    const { name, monthlyBudget, startDate, endDate, status } = req.body;
    if (!name || monthlyBudget === undefined || monthlyBudget === null || !startDate) {
      return res.status(400).json({ error: 'Name, monthly budget, and start date are required' });
    }
    const budgetAmount = parseFloat(monthlyBudget);
    if (isNaN(budgetAmount) || budgetAmount < 0) {
      return res.status(400).json({ error: 'Monthly budget must be a positive number' });
    }
    const budget = await updateBudget(req.userId, budgetId, {
      name,
      monthlyBudget: budgetAmount,
      startDate,
      endDate,
      status
    });
    res.json({ message: 'Budget updated successfully', budget });
  } catch (error) {
    console.error('Update budget error:', error);
    res.status(500).json({ error: error.message || 'Failed to update budget' });
  }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await getBudgetStats(req.userId);
    res.json({ stats });
  } catch (error) {
    console.error('Get budget stats error:', error);
    res.status(500).json({ error: error.message || 'Failed to get budget statistics' });
  }
});

export default router;
