const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://valzyy:_aZGK-UPaPUEsHuYnayfEA@dashboard-8638.j77.aws-ap-southeast-1.cockroachlabs.cloud:26257/restapi?sslmode=verify-full',
  ssl: {
    rejectUnauthorized: false
  }
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-here';

// JKT48 API Configuration
const JKT48_API_BASE = 'https://v2.jkt48connect.my.id/api/admin/create-key';
const JKT48_ADMIN_USERNAME = process.env.JKT48_ADMIN_USERNAME || 'vzy';
const JKT48_ADMIN_PASSWORD = process.env.JKT48_ADMIN_PASSWORD || 'vzy';

// Initialize database tables
async function initDatabase() {
  try {
    const createUsersTable = `
      CREATE TABLE IF NOT EXISTS dashjkt48 (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        username VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20) NOT NULL,
        member_number VARCHAR(20) UNIQUE NOT NULL,
        api_key VARCHAR(50) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        type VARCHAR(20) DEFAULT 'free',
        oshi VARCHAR(255) DEFAULT 'JKT48',
        barcode VARCHAR(255),
        balance DECIMAL(10,2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    
    await pool.query(createUsersTable);
    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Initialize database on startup
initDatabase();

// Helper function to generate member number
function generateMemberNumber() {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `JKT${timestamp}${random}`;
}

// Helper function to generate API key
function generateApiKey() {
  const random = Math.random().toString(36).substring(2, 10).toUpperCase();
  return `JC-${random}`;
}

// Helper function to generate barcode string
function generateBarcodeString() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Helper function to create JKT48 API key
async function createJKT48ApiKey(username, email, type, apiKey) {
  try {
    const response = await axios.get(JKT48_API_BASE, {
      params: {
        username: JKT48_ADMIN_USERNAME,
        password: JKT48_ADMIN_PASSWORD,
        owner: username,
        email: email,
        type: type,
        apikey: apiKey
      },
      timeout: 10000 // 10 seconds timeout
    });

    if (response.data && response.data.status === true) {
      console.log('JKT48 API key created successfully:', response.data);
      return {
        success: true,
        data: response.data
      };
    } else {
      console.error('JKT48 API key creation failed:', response.data);
      return {
        success: false,
        error: response.data?.message || 'Unknown error'
      };
    }
  } catch (error) {
    console.error('Error creating JKT48 API key:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Register endpoint
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, username, phone } = req.body;

    // Validate input
    if (!email || !password || !username || !phone) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT * FROM dashjkt48 WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User already exists'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate user data
    const memberNumber = generateMemberNumber();
    const apiKey = generateApiKey();
    const barcodeString = generateBarcodeString();

    // Create API key in JKT48 system first
    const jktResult = await createJKT48ApiKey(username, email, 'free', apiKey);
    
    if (!jktResult.success) {
      console.warn('JKT48 API key creation failed, but continuing with registration:', jktResult.error);
      // Continue with registration even if JKT48 API fails
    }

    // Insert user into database
    const insertQuery = `
      INSERT INTO dashjkt48 (email, password, username, phone, member_number, api_key, barcode)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, email, username, phone, member_number, api_key, status, type, oshi, balance, created_at
    `;

    const result = await pool.query(insertQuery, [
      email,
      hashedPassword,
      username,
      phone,
      memberNumber,
      apiKey,
      barcodeString
    ]);

    const newUser = result.rows[0];

    // Generate JWT token
    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email, apiKey: newUser.api_key },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        token,
        user: {
          id: newUser.id,
          email: newUser.email,
          username: newUser.username,
          phone: newUser.phone,
          memberNumber: newUser.member_number,
          apiKey: newUser.api_key,
          status: newUser.status,
          type: newUser.type,
          oshi: newUser.oshi,
          balance: newUser.balance,
          barcode: barcodeString,
          createdAt: newUser.created_at
        },
        jkt48ApiResult: jktResult.success ? jktResult.data : null
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    // Find user
    const userQuery = 'SELECT * FROM dashjkt48 WHERE email = $1';
    const userResult = await pool.query(userQuery, [email]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = userResult.rows[0];

    // Check password
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, apiKey: user.api_key },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          phone: user.phone,
          memberNumber: user.member_number,
          apiKey: user.api_key,
          status: user.status,
          type: user.type,
          oshi: user.oshi,
          balance: user.balance,
          barcode: user.barcode,
          createdAt: user.created_at
        }
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Middleware to authenticate JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access token required'
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired token'
      });
    }
    req.user = user;
    next();
  });
}

// Get user profile
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const userQuery = 'SELECT * FROM dashjkt48 WHERE id = $1';
    const userResult = await pool.query(userQuery, [req.user.userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = userResult.rows[0];

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        username: user.username,
        phone: user.phone,
        memberNumber: user.member_number,
        apiKey: user.api_key,
        status: user.status,
        type: user.type,
        oshi: user.oshi,
        balance: user.balance,
        barcode: user.barcode,
        createdAt: user.created_at,
        updatedAt: user.updated_at
      }
    });

  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get all users (admin endpoint)
app.get('/api/users', async (req, res) => {
  try {
    const usersQuery = 'SELECT id, email, username, phone, member_number, api_key, status, type, oshi, balance, created_at FROM dashjkt48 ORDER BY created_at DESC';
    const result = await pool.query(usersQuery);

    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length
    });

  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'JKT48 API System',
    version: '1.0.0',
    endpoints: {
      register: 'POST /api/register',
      login: 'POST /api/login',
      profile: 'GET /api/profile',
      users: 'GET /api/users',
      health: 'GET /api/health'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Export for Vercel
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;
