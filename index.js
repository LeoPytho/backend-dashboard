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

    // Table untuk menyimpan token - creator_id sekarang nullable
    const createTokensTable = `
      CREATE TABLE IF NOT EXISTS tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        usage_limit INTEGER DEFAULT 1,
        usage_count INTEGER DEFAULT 0,
        expires_at TIMESTAMP,
        whatsapp_number VARCHAR(20),
        creator_id UUID REFERENCES dashjkt48(id),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // Table untuk tracking penggunaan token - user_id sekarang nullable
    const createTokenUsageTable = `
      CREATE TABLE IF NOT EXISTS token_usage (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_id UUID REFERENCES tokens(id),
        user_id UUID REFERENCES dashjkt48(id),
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        purpose VARCHAR(255),
        metadata JSONB,
        user_info JSONB
      );
    `;

    await pool.query(createUsersTable);
    await pool.query(createTokensTable);
    await pool.query(createTokenUsageTable);
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

// Helper function to generate token code
function generateTokenCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'VC-';
  for (let i = 0; i < 8; i++) {
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
      timeout: 10000
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

// ================== TOKEN MANAGEMENT ENDPOINTS ==================

// Create Token - NO AUTHENTICATION REQUIRED
app.post('/api/tokens/create', async (req, res) => {
  try {
    const { name, description, usageLimit, expiresAt, whatsappNumber, creatorInfo } = req.body;

    // Validate input
    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Token name is required'
      });
    }

    const tokenCode = generateTokenCode();
    let expiresAtDate = null;

    if (expiresAt) {
      expiresAtDate = new Date(expiresAt);
      if (isNaN(expiresAtDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid expiration date format'
        });
      }
    }

    const insertQuery = `
      INSERT INTO tokens (token_code, name, description, usage_limit, expires_at, whatsapp_number, creator_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const result = await pool.query(insertQuery, [
      tokenCode,
      name,
      description || null,
      usageLimit || 1,
      expiresAtDate,
      whatsappNumber || null,
      null // creator_id is now null since no authentication required
    ]);

    const newToken = result.rows[0];

    res.status(201).json({
      success: true,
      message: 'Token created successfully',
      data: {
        id: newToken.id,
        tokenCode: newToken.token_code,
        name: newToken.name,
        description: newToken.description,
        usageLimit: newToken.usage_limit,
        usageCount: newToken.usage_count,
        expiresAt: newToken.expires_at,
        whatsappNumber: newToken.whatsapp_number,
        isActive: newToken.is_active,
        createdAt: newToken.created_at
      }
    });

  } catch (error) {
    console.error('Token creation error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get all tokens - NO AUTHENTICATION REQUIRED
app.get('/api/tokens', async (req, res) => {
  try {
    const tokensQuery = `
      SELECT t.*, u.username as creator_username
      FROM tokens t
      LEFT JOIN dashjkt48 u ON t.creator_id = u.id
      ORDER BY t.created_at DESC
    `;

    const result = await pool.query(tokensQuery);

    const tokens = result.rows.map(token => ({
      id: token.id,
      tokenCode: token.token_code,
      name: token.name,
      description: token.description,
      usageLimit: token.usage_limit,
      usageCount: token.usage_count,
      expiresAt: token.expires_at,
      whatsappNumber: token.whatsapp_number,
      creatorUsername: token.creator_username,
      isActive: token.is_active,
      createdAt: token.created_at,
      updatedAt: token.updated_at
    }));

    res.json({
      success: true,
      data: tokens,
      total: tokens.length
    });

  } catch (error) {
    console.error('Tokens fetch error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Validate Token - NO AUTHENTICATION REQUIRED
app.post('/api/tokens/validate', async (req, res) => {
  try {
    const { tokenCode, whatsappNumber } = req.body;

    if (!tokenCode) {
      return res.status(400).json({
        success: false,
        message: 'Token code is required'
      });
    }

    const tokenQuery = 'SELECT * FROM tokens WHERE token_code = $1';
    const tokenResult = await pool.query(tokenQuery, [tokenCode]);

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Token not found'
      });
    }

    const token = tokenResult.rows[0];

    // Check if token is active
    if (!token.is_active) {
      return res.status(400).json({
        success: false,
        message: 'Token is inactive'
      });
    }

    // Check expiration
    if (token.expires_at && new Date() > new Date(token.expires_at)) {
      return res.status(400).json({
        success: false,
        message: 'Token has expired'
      });
    }

    // Check usage limit
    if (token.usage_count >= token.usage_limit) {
      return res.status(400).json({
        success: false,
        message: 'Token usage limit exceeded'
      });
    }

    // Check WhatsApp number if specified
    if (token.whatsapp_number && whatsappNumber && token.whatsapp_number !== whatsappNumber) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp number does not match'
      });
    }

    res.json({
      success: true,
      message: 'Token is valid',
      data: {
        id: token.id,
        tokenCode: token.token_code,
        name: token.name,
        description: token.description,
        usageLimit: token.usage_limit,
        usageCount: token.usage_count,
        remainingUses: token.usage_limit - token.usage_count,
        expiresAt: token.expires_at,
        whatsappNumber: token.whatsapp_number,
        isActive: token.is_active
      }
    });

  } catch (error) {
    console.error('Token validation error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Use Token - NO AUTHENTICATION REQUIRED
app.post('/api/tokens/use', async (req, res) => {
  try {
    const { tokenCode, purpose, whatsappNumber, metadata, userInfo } = req.body;

    if (!tokenCode) {
      return res.status(400).json({
        success: false,
        message: 'Token code is required'
      });
    }

    // Start transaction
    await pool.query('BEGIN');

    try {
      // Get token with lock
      const tokenQuery = 'SELECT * FROM tokens WHERE token_code = $1 FOR UPDATE';
      const tokenResult = await pool.query(tokenQuery, [tokenCode]);

      if (tokenResult.rows.length === 0) {
        throw new Error('Token not found');
      }

      const token = tokenResult.rows[0];

      // Validate token
      if (!token.is_active) {
        throw new Error('Token is inactive');
      }

      if (token.expires_at && new Date() > new Date(token.expires_at)) {
        throw new Error('Token has expired');
      }

      if (token.usage_count >= token.usage_limit) {
        throw new Error('Token usage limit exceeded');
      }

      if (token.whatsapp_number && whatsappNumber && token.whatsapp_number !== whatsappNumber) {
        throw new Error('WhatsApp number does not match');
      }

      // Record usage
      const usageQuery = `
        INSERT INTO token_usage (token_id, user_id, purpose, metadata, user_info)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;

      const usageResult = await pool.query(usageQuery, [
        token.id,
        null, // user_id is null since no authentication required
        purpose || 'General use',
        metadata ? JSON.stringify(metadata) : null,
        userInfo ? JSON.stringify(userInfo) : null
      ]);

      // Update token usage count
      const updateQuery = `
        UPDATE tokens 
        SET usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `;

      const updateResult = await pool.query(updateQuery, [token.id]);
      const updatedToken = updateResult.rows[0];

      // Commit transaction
      await pool.query('COMMIT');

      res.json({
        success: true,
        message: 'Token used successfully',
        data: {
          tokenCode: updatedToken.token_code,
          name: updatedToken.name,
          usageCount: updatedToken.usage_count,
          remainingUses: updatedToken.usage_limit - updatedToken.usage_count,
          usageId: usageResult.rows[0].id,
          usedAt: usageResult.rows[0].used_at,
          purpose: purpose || 'General use'
        }
      });

    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    console.error('Token usage error:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get token usage history - NO AUTHENTICATION REQUIRED
app.get('/api/tokens/:tokenCode/usage', async (req, res) => {
  try {
    const { tokenCode } = req.params;

    const usageQuery = `
      SELECT tu.*, u.username, u.phone, t.name as token_name
      FROM token_usage tu
      JOIN tokens t ON tu.token_id = t.id
      LEFT JOIN dashjkt48 u ON tu.user_id = u.id
      WHERE t.token_code = $1
      ORDER BY tu.used_at DESC
    `;

    const result = await pool.query(usageQuery, [tokenCode]);

    const usage = result.rows.map(row => ({
      id: row.id,
      tokenName: row.token_name,
      username: row.username,
      phone: row.phone,
      purpose: row.purpose,
      metadata: row.metadata,
      userInfo: row.user_info,
      usedAt: row.used_at
    }));

    res.json({
      success: true,
      data: usage,
      total: usage.length
    });

  } catch (error) {
    console.error('Token usage history error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update token status (activate/deactivate) - NO AUTHENTICATION REQUIRED
app.patch('/api/tokens/:tokenCode/status', async (req, res) => {
  try {
    const { tokenCode } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean value'
      });
    }

    const updateQuery = `
      UPDATE tokens 
      SET is_active = $1, updated_at = CURRENT_TIMESTAMP
      WHERE token_code = $2
      RETURNING *
    `;

    const result = await pool.query(updateQuery, [isActive, tokenCode]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Token not found'
      });
    }

    const token = result.rows[0];

    res.json({
      success: true,
      message: `Token ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: {
        tokenCode: token.token_code,
        name: token.name,
        isActive: token.is_active,
        updatedAt: token.updated_at
      }
    });

  } catch (error) {
    console.error('Token status update error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Delete token - NO AUTHENTICATION REQUIRED
app.delete('/api/tokens/:tokenCode', async (req, res) => {
  try {
    const { tokenCode } = req.params;

    // Start transaction
    await pool.query('BEGIN');

    try {
      // Delete usage records first
      await pool.query('DELETE FROM token_usage WHERE token_id = (SELECT id FROM tokens WHERE token_code = $1)', [tokenCode]);

      // Delete token
      const deleteQuery = 'DELETE FROM tokens WHERE token_code = $1 RETURNING *';
      const result = await pool.query(deleteQuery, [tokenCode]);

      if (result.rows.length === 0) {
        throw new Error('Token not found');
      }

      await pool.query('COMMIT');

      res.json({
        success: true,
        message: 'Token deleted successfully',
        data: {
          tokenCode: result.rows[0].token_code,
          name: result.rows[0].name
        }
      });

    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    console.error('Token deletion error:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Internal server error',
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
    message: 'JKT48 API System with Token Management',
    version: '1.2.0',
    endpoints: {
      // User endpoints
      register: 'POST /api/register',
      login: 'POST /api/login',
      profile: 'GET /api/profile (requires auth)',
      users: 'GET /api/users',
      health: 'GET /api/health',
      
      // Token endpoints (no authentication required)
      createToken: 'POST /api/tokens/create',
      getTokens: 'GET /api/tokens',
      validateToken: 'POST /api/tokens/validate',
      useToken: 'POST /api/tokens/use',
      getTokenUsage: 'GET /api/tokens/:tokenCode/usage',
      updateTokenStatus: 'PATCH /api/tokens/:tokenCode/status',
      deleteToken: 'DELETE /api/tokens/:tokenCode'
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
