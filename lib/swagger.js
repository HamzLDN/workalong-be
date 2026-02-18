import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'WorkAlong API',
      version: '1.0.0',
      description: 'API documentation for WorkAlong - Staff Management and Scheduling System',
      contact: {
        name: 'WorkAlong Support',
        email: 'company@workalong.co.uk'
      }
    },
    servers: [
      {
        url: 'http://localhost:3001/api',
        description: 'Development server'
      },
      {
        url: 'https://api.workalong.co.uk',
        description: 'Production API server'
      },
      {
        url: 'https://workalong.co.uk/api',
        description: 'Production server (main domain)'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Session token or API key'
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sessionId',
          description: 'Session cookie authentication'
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key for programmatic access'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Error message'
            }
          }
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            email: { type: 'string', format: 'email' },
            name: { type: 'string' },
            subscription_status: { type: 'string' },
            subscription_plan: { type: 'string' }
          }
        },
        Staff: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            user_id: { type: 'integer' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            role: { type: 'string' },
            hourly_rate: { type: 'number', format: 'float' },
            employment_type: { type: 'string' },
            is_active: { type: 'boolean' }
          }
        },
        Shift: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            user_id: { type: 'integer' },
            staff_id: { type: 'integer' },
            shift_date: { type: 'string', format: 'date' },
            start_time: { type: 'string' },
            hours: { type: 'number', format: 'float' },
            status: { type: 'string', enum: ['scheduled', 'completed', 'approved', 'cancelled', 'late', 'unattended'] },
            location: { type: 'string' },
            notes: { type: 'string' }
          }
        },
        Session: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            user_id: { type: 'integer' },
            expires_at: { type: 'string', format: 'date-time' }
          }
        }
      }
    },
    tags: [
      {
        name: 'Health',
        description: 'Health check endpoints'
      },
      {
        name: 'Authentication',
        description: 'User authentication and session management'
      },
      {
        name: 'Staff',
        description: 'Staff member management'
      },
      {
        name: 'Shifts',
        description: 'Shift scheduling and management'
      },
      {
        name: 'Time Entries',
        description: 'Time tracking and clock in/out'
      },
      {
        name: 'Budgets',
        description: 'Budget management'
      },
      {
        name: 'Payments',
        description: 'Payment processing and references'
      },
      {
        name: 'Security',
        description: 'API keys, CSRF tokens, and security features'
      },
      {
        name: 'Activities',
        description: 'Activity feed and logging'
      },
      {
        name: 'Fraud Detection',
        description: 'Fraud pattern detection and analysis'
      }
    ]
  },
  apis: ['./routes/*.js', './index.js'] // Path to the API files
};

export const swaggerSpec = swaggerJsdoc(options);

