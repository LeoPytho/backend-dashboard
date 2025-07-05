const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const JBarcode = require('jsbarcode');
const { createCanvas } = require('canvas');
const jkt48Api = require('@jkt48/core');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database configuration
const pool = new Pool({
  connectionString: 'postgresql://valzyy:_aZGK-UPaPUEsHuYnayfEA@dashboard-8638.j77.aws-ap-southeast-1.cockroachlabs.cloud:26257/restapi?sslmode=verify-full',
  ssl: {
    rejectUnauthorized: false
  }
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-here';

// Initialize database tables
async function initDatabase() {
  try {
    const createUsersTable = `
      CREATE TABLE IF NOT EXISTS users (
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
        barcode TEXT,
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

// Helper function to generate barcode
function generateBarcode(memberNumber) {
  const canvas = createCanvas(200, 100);
  JBarcode(canvas, memberNumber, {
    format: "CODE128",
    width: 2,
    height: 100,
    displayValue: true
  });
  return canvas.toDataURL();
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
      'SELECT * FROM users WHERE email = $1 OR username = $2',
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
    const barcode = generateBarcode(memberNumber);

    // Insert user into database
    const insertQuery = `
      INSERT INTO users (email, password, username, phone, member_number, api_key, barcode)
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
      barcode
    ]);

    const newUser = result.rows[0];

    // Create API key in JKT48 core system
    try {
      await jkt48Api.admin.createKey(username, email, 'free', apiKey);
      console.log(`API key created in JKT48 core system for user: ${username}`);
    } catch (jktError) {
      console.error('Error creating API key in JKT48 core:', jktError);
    }

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
          barcode: barcode,
          createdAt: newUser.created_at
        }
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
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
    const userQuery = 'SELECT * FROM users WHERE email = $1';
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
      message: 'Internal server error'
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
    const userQuery = 'SELECT * FROM users WHERE id = $1';
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
      message: 'Internal server error'
    });
  }
});

// Get all users (admin endpoint)
app.get('/api/users', async (req, res) => {
  try {
    const usersQuery = 'SELECT id, email, username, phone, member_number, api_key, status, type, oshi, balance, created_at FROM users ORDER BY created_at DESC';
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
      message: 'Internal server error'
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is running',
    timestamp: new Date().toISOString()
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
    message: 'Something went wrong!'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;
