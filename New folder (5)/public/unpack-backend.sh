#!/bin/bash
mkdir -p backend-project
mkdir -p "backend-project/src/api/controllers"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/controllers/authController.ts"
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key-for-dev';

export const login = (req: Request, res: Response) => {
  const { email, password } = req.body;
  const token = jwt.sign({ id: '1', email, role: 'customer' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: '1', email, role: 'customer' } });
};

export const register = (req: Request, res: Response) => {
  const { name, email, password } = req.body;
  const token = jwt.sign({ id: '1', email, role: 'customer' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: '1', name, email, role: 'customer' } });
};

export const getMe = (req: any, res: Response) => {
  res.json({ user: { id: req.user?.uid || '1', email: req.user?.email, role: 'customer' } });
};

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/controllers"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/controllers/xuiController.ts"
import { Request, Response } from 'express';
import { xuiService } from '../services/xuiService.ts';
import { adminDb } from '../config/firebaseAdmin.ts';

export const getXuiSettings = async (req: Request, res: Response) => {
  try {
    const doc = await adminDb.collection('settings').doc('xui').get();
    if (doc.exists) {
      const data = doc.data();
      // Mask password
      if (data?.password) data.password = '********';
      res.json({ success: true, data });
    } else {
      res.json({ success: true, data: null });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const saveXuiSettings = async (req: Request, res: Response) => {
  try {
    let { panelUrl, username, password, panelName } = req.body;
    
    // If password is '********', don't update it in db, but fetch actual for testing
    let actualPassword = password;
    if (password === '********') {
      const doc = await adminDb.collection('settings').doc('xui').get();
      actualPassword = doc.data()?.password;
    }
    
    const updateData: any = { panelUrl, username, panelName, updatedAt: new Date() };
    if (password && password !== '********') {
      updateData.password = password;
    }

    await adminDb.collection('settings').doc('xui').set(updateData, { merge: true });
    
    // Test the new connection
    const connected = await xuiService.testConnection(panelUrl, username, actualPassword);
    
    if (connected) {
      await adminDb.collection('settings').doc('xui').update({ status: 'connected', lastSync: new Date() });
    } else {
      await adminDb.collection('settings').doc('xui').update({ status: 'disconnected' });
    }

    res.json({ success: true, connected });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const disconnectXui = async (req: Request, res: Response) => {
  try {
    await adminDb.collection('settings').doc('xui').delete();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const testConnection = async (req: Request, res: Response) => {
  try {
    let { panelUrl, username, password } = req.body;
    if (password === '********') {
      const doc = await adminDb.collection('settings').doc('xui').get();
      password = doc.data()?.password;
    }
    const connected = await xuiService.testConnection(panelUrl, username, password);
    res.json({ success: true, connected });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const syncClients = async (req: Request, res: Response) => {
  res.json({ message: 'Syncing clients not yet implemented' });
};

export const getClientStatus = async (req: Request, res: Response) => {
  res.json({ message: 'Live status not yet implemented' });
};

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/controllers"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/controllers/userController.ts"
import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware.ts';

export const getDashboard = (req: AuthRequest, res: Response) => {
  res.json({ success: false, data: null });
};

export const getProfile = (req: AuthRequest, res: Response) => {
  res.json({ id: req.user?.uid || '1', name: 'User' });
};

export const getVpn = (req: AuthRequest, res: Response) => {
  res.json({ success: false, data: null });
};

export const getSupport = (req: AuthRequest, res: Response) => {
  res.json({ tickets: [] });
};

export const getDownloads = (req: AuthRequest, res: Response) => {
  res.json([]);
};

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/routes"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/routes/clientRoutes.ts"
import { Router } from 'express';
import axios from 'axios';
import { adminDb } from '../config/firebaseAdmin.ts';
import { requireAuth } from '../middleware/authMiddleware.ts';

export const clientRouter = Router();

clientRouter.use(requireAuth);

clientRouter.get('/:email', async (req, res) => {
  try {
    const email = req.params.email;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Missing email' });
    }

    const doc = await adminDb.collection('settings').doc('xui').get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: '3X-UI not configured' });
    }
    const { panelUrl, username, password, panelName } = doc.data() as any;
    const apiToken = password;

    if (!panelUrl || !apiToken) {
      return res.status(404).json({ success: false, message: '3X-UI credentials missing' });
    }

    const baseUrl = panelUrl.replace(/\/$/, '');
    let headers: any = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiToken}`
    };

    if (username) {
        try {
            const loginRes = await axios.post(`${baseUrl}/login`, { username, password }, { timeout: 5000 });
            if (loginRes.data && loginRes.data.success && loginRes.headers['set-cookie']) {
                // Pass all set-cookies to the next request
                headers['Cookie'] = loginRes.headers['set-cookie'].join('; ');
            }
        } catch (e) {
            console.log('Cookie login failed in clientRoutes, falling back to Bearer token');
        }
    }

    // First try to fetch the client directly
    let clientData: any = null;
    try {
      const getClientResp = await axios.get(`${baseUrl}/panel/api/client/get/${encodeURIComponent(email)}`, { headers, timeout: 5000 });
      if (getClientResp.data && getClientResp.data.success && getClientResp.data.obj) {
        clientData = getClientResp.data.obj;
      }
    } catch (e: any) {
      // It might not exist as an endpoint, or client not found
      console.log('Error fetching direct client, fallback to inbounds list', e.message);
    }

    // Fallback: fetch all inbounds and search for the client
    if (!clientData) {
        const inboundsResp = await axios.get(`${baseUrl}/panel/api/inbounds/list`, { headers, timeout: 5000 });
        if (inboundsResp.data && inboundsResp.data.success && inboundsResp.data.obj) {
            for (const inbound of inboundsResp.data.obj) {
                if (inbound.settings) {
                    try {
                        const settings = JSON.parse(inbound.settings);
                        if (settings.clients) {
                            const client = settings.clients.find((c: any) => c.email === email);
                            if (client) {
                                clientData = client;
                                clientData.inboundId = inbound.id;
                                clientData.inboundName = inbound.remark;
                                clientData.port = inbound.port;
                                clientData.protocol = inbound.protocol;
                                
                                // Stream settings
                                if (inbound.streamSettings) {
                                    const streamSettings = JSON.parse(inbound.streamSettings);
                                    clientData.network = streamSettings.network;
                                    clientData.security = streamSettings.security;
                                }
                                break;
                            }
                        }
                    } catch (e) {}
                }
            }
        }
    }

    if (!clientData) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    // Now get traffic
    let trafficData: any = null;
    try {
        const trafficResp = await axios.get(`${baseUrl}/panel/api/client/traffic/${encodeURIComponent(email)}`, { headers, timeout: 5000 });
        if (trafficResp.data && trafficResp.data.success && trafficResp.data.obj) {
            trafficData = trafficResp.data.obj;
        } else {
            // some versions use inbounds/getClientTraffics/:email
            const trafficResp2 = await axios.get(`${baseUrl}/panel/api/inbounds/getClientTraffics/${encodeURIComponent(email)}`, { headers, timeout: 5000 });
            if (trafficResp2.data && trafficResp2.data.success && trafficResp2.data.obj) {
                trafficData = trafficResp2.data.obj;
            }
        }
    } catch (e) {
        console.log('Error fetching traffic via /panel/api/client/traffic, trying /panel/api/inbounds/getClientTraffics', e);
        try {
            const trafficResp2 = await axios.get(`${baseUrl}/panel/api/inbounds/getClientTraffics/${encodeURIComponent(email)}`, { headers, timeout: 5000 });
            if (trafficResp2.data && trafficResp2.data.success && trafficResp2.data.obj) {
                trafficData = trafficResp2.data.obj;
            }
        } catch (e2) {}
    }

    // We have clientData and possibly trafficData. Let's merge it into the required format.
    const responseData = {
        email: email,
        uuid: clientData.id || clientData.uuid,
        status: clientData.enable ? 'active' : 'inactive',
        down: trafficData ? trafficData.down : 0,
        up: trafficData ? trafficData.up : 0,
        totalDataUsed: trafficData ? (trafficData.down + trafficData.up) : 0,
        trafficLimit: clientData.totalGB ? clientData.totalGB : (trafficData ? trafficData.total : 0),
        expiryDate: clientData.expiryTime > 0 ? clientData.expiryTime : null, // 3x-ui usually uses expiryTime in ms
        onlineStatus: trafficData ? (trafficData.enable ? 'online' : 'offline') : 'unknown',
        inboundName: clientData.inboundName || 'Unknown Inbound',
        serverName: panelName || '3X-UI Server',
        serverAddress: panelUrl.replace(/^https?:\/\//, '').split(':')[0],
        port: clientData.port || 443,
        protocol: clientData.protocol || 'vless',
        network: clientData.network || 'tcp',
        security: clientData.security || 'none',
        connectionUri: ''
    };

    // Calculate connection URI if possible (very basic fallback if not provided by API)
    if (clientData.id && responseData.serverAddress) {
        responseData.connectionUri = `${responseData.protocol}://${clientData.id}@${responseData.serverAddress}:${responseData.port}?type=${responseData.network}&security=${responseData.security}#${encodeURIComponent(responseData.serverName)}`;
    }

    res.json({ success: true, data: responseData });

  } catch (error: any) {
    console.error("Client API Error:", error.message);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/routes"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/routes/authRoutes.ts"
import { Router } from 'express';
import { login, register, getMe } from '../controllers/authController.ts';
import { requireAuth } from '../middleware/authMiddleware.ts';

export const authRouter = Router();

authRouter.post('/login', login);
authRouter.post('/register', register);
authRouter.get('/me', requireAuth, getMe);

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/routes"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/routes/userRoutes.ts"
import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware.ts';
import { getDashboard, getProfile, getVpn, getSupport, getDownloads } from '../controllers/userController.ts';

export const userRouter = Router();

// Apply auth middleware to all routes below
userRouter.use(requireAuth);

userRouter.get('/dashboard', getDashboard);
userRouter.get('/profile', getProfile);
userRouter.get('/vpn', getVpn);
userRouter.get('/support', getSupport);
userRouter.get('/downloads', getDownloads);

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/routes"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/routes/adminRoutes.ts"
import { Router } from 'express';
import { adminDb } from '../config/firebaseAdmin.ts';
import { getAuth } from 'firebase-admin/auth';
import axios from 'axios';
import { requireAuth, requireAdmin } from '../middleware/authMiddleware.ts';

export const adminRouter = Router();

adminRouter.use(requireAuth);
adminRouter.use(requireAdmin);

adminRouter.get('/stats', async (req, res) => {
  try {
    // 1. Get total users count from Firebase Auth
    let usersCount = 0;
    try {
      const listUsersResult = await getAuth().listUsers(1000);
      usersCount = listUsersResult.users.length;
    } catch (e) {
      console.error('Error fetching users from Firebase:', e);
    }

    // 2. Get active VPNs count from 3X-UI
    let activeVpnsCount = 0;
    try {
      const doc = await adminDb.collection('settings').doc('xui').get();
      if (doc.exists) {
        const { panelUrl, username, password } = doc.data() as any;
        const apiToken = password;
        if (panelUrl && apiToken) {
          const baseUrl = panelUrl.replace(/\/$/, '');
          let headers: any = { 'Accept': 'application/json', 'Authorization': `Bearer ${apiToken}` };
          
          if (username) {
            try {
                const loginRes = await axios.post(`${baseUrl}/login`, { username, password }, { timeout: 5000 });
                if (loginRes.data && loginRes.data.success && loginRes.headers['set-cookie']) {
                    headers['Cookie'] = loginRes.headers['set-cookie'].join('; ');
                }
            } catch (e) {}
          }
          const inboundsResp = await axios.get(`${baseUrl}/panel/api/inbounds/list`, { headers, timeout: 5000 });
          if (inboundsResp.data && inboundsResp.data.success && inboundsResp.data.obj) {
            for (const inbound of inboundsResp.data.obj) {
              if (inbound.settings) {
                try {
                  const settings = JSON.parse(inbound.settings);
                  if (settings.clients) {
                    activeVpnsCount += settings.clients.filter((c: any) => c.enable === true).length;
                  }
                } catch (e) {}
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('Error fetching active VPNs from 3X-UI:', e);
    }

    res.json({ success: true, data: { users: usersCount, activeVpns: activeVpnsCount } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/routes"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/routes/threeXuiRoutes.ts"
import { Router } from 'express';
import axios from 'axios';

export const threeXuiRouter = Router();

threeXuiRouter.post('/test', async (req, res) => {
  try {
    const { panelUrl, apiToken } = req.body;

    if (!panelUrl || !apiToken) {
      return res.status(400).json({ success: false, message: 'Missing panelUrl or apiToken' });
    }

    // According to 3x-ui v3.2.6 API, programmatic clients authenticate with a Bearer token
    const response = await axios.get(`${panelUrl.replace(/\/$/, '')}/panel/api/server/status`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      timeout: 5000
    });

    if (response.data && response.data.success) {
      res.json({
        success: true,
        message: 'Connected to 3X-UI',
        data: response.data
      });
    } else {
      res.status(response.status).json({
        success: false,
        message: 'Connection failed',
        data: response.data
      });
    }
  } catch (error: any) {
    console.error("3X-UI Connection Error:", error.message, error.response?.data);
    
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        message: error.response.data?.msg || error.response.data?.message || 'Authentication failed',
        errorData: error.response.data
      });
    } else if (error.request) {
      res.status(503).json({
        success: false,
        message: 'No response received from the panel. Check URL and connectivity.',
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Error setting up the request',
        error: error.message
      });
    }
  }
});

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/routes"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/routes/xuiRoutes.ts"
import { Router } from 'express';
import { syncClients, getClientStatus, getXuiSettings, saveXuiSettings, disconnectXui, testConnection } from '../controllers/xuiController.ts';
import { requireAuth, requireAdmin } from '../middleware/authMiddleware.ts';

export const xuiRouter = Router();

xuiRouter.use(requireAuth);

xuiRouter.get('/settings', requireAdmin, getXuiSettings);
xuiRouter.post('/settings', requireAdmin, saveXuiSettings);
xuiRouter.post('/disconnect', requireAdmin, disconnectXui);
xuiRouter.post('/test', requireAdmin, testConnection);

xuiRouter.post('/sync', requireAdmin, syncClients);
xuiRouter.get('/status/:clientId', requireAdmin, getClientStatus);

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/middleware"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/middleware/authMiddleware.ts"
import { Request, Response, NextFunction } from 'express';
import { adminAuth, adminDb } from '../config/firebaseAdmin.ts';

export interface AuthRequest extends Request {
  user?: any;
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

export const requireAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user || !req.user.uid) {
      return res.status(401).json({ error: 'Unauthorized: User not found in request' });
    }
    
    // Check Firestore for admin role
    const userDoc = await adminDb.collection('users').doc(req.user.uid).get();
    
    if (userDoc.exists && userDoc.data()?.role === 'admin') {
      next();
    } else if (req.user.email === 'madushannimesha16@gmail.com') { // fallback for primary admin
      next();
    } else {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
  } catch (error) {
    console.error("Error in requireAdmin middleware:", error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/services"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/services/xuiService.ts"
import axios from 'axios';
/**
 * Service to interact with the 3X-UI panel API.
 * 
 * TODO: Implement live API integration.
 * - Login to 3X-UI
 * - Fetch client list
 * - Fetch traffic usage
 * - Fetch expiry
 * - Fetch online status
 * - Fetch VLESS/VMess/Trojan configurations
 */

export class XuiService {
  private baseUrl: string;
  private token: string | null = null;

  constructor() {
    this.baseUrl = process.env.XUI_API_URL || '';
  }

  async testConnection(url: string, username?: string, password?: string): Promise<boolean> {
    try {
      if (!url || !password) return false;
      const baseUrl = url.replace(/\/$/, '');
      
      if (username) {
        try {
          const loginRes = await axios.post(`${baseUrl}/login`, { username, password }, { timeout: 5000 });
          if (loginRes.data && loginRes.data.success) {
            return true;
          }
        } catch (err: any) {
          console.log('Cookie login failed, trying API token fallback...', err.message);
        }
      }

      // Try Bearer token
      try {
          const apiRes = await axios.get(`${baseUrl}/panel/api/server/status`, {
            headers: {
              'Accept': 'application/json',
              'Authorization': `Bearer ${password}`
            },
            timeout: 5000
          });
          return !!(apiRes.data && apiRes.data.success);
      } catch (err: any) {
          console.error('Bearer login failed...', err.message);
          return false;
      }
    } catch (e: any) {
      console.error('Failed to test connection', e.message);
      return false;
    }
  }

  async login() {
    // TODO: Implement login to /login with username and password
    console.log('Logging in to 3X-UI...');
  }

  async getClientList() {
    // TODO: Implement fetching clients
    return [];
  }

  async getClientTraffic(clientId: string) {
    // TODO: Fetch traffic usage
  }

  async getClientConfig(clientId: string) {
    // TODO: Fetch VLESS/VMess/Trojan configuration
  }
}

export const xuiService = new XuiService();

EOF_BACKEND_FILE
mkdir -p "backend-project/src/api/config"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/api/config/firebaseAdmin.ts"
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  initializeApp({
    projectId: "firevpns-a36d7",
  });
}

export const adminAuth = getAuth();
export const adminDb = getFirestore();

EOF_BACKEND_FILE
mkdir -p "backend-project/src/lib"
cat << 'EOF_BACKEND_FILE' > "backend-project/src/lib/firebase.ts"
import { initializeApp } from 'firebase/app';
import { getAuth, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyDTIIi1bUAOcxYnomND9yec3KkvY-LWPOA",
  authDomain: "firevpns-a36d7.firebaseapp.com",
  databaseURL: "https://firevpns-a36d7-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "firevpns-a36d7",
  storageBucket: "firevpns-a36d7.firebasestorage.app",
  messagingSenderId: "730051637429",
  appId: "1:730051637429:web:0874542c5cc8bf3c5bcefc"
};

const app = initializeApp(firebaseConfig);
const secondaryApp = initializeApp(firebaseConfig, "SecondaryApp");

export const auth = getAuth(app);
export const secondaryAuth = getAuth(secondaryApp);

// Initialize Firestore
export const db = getFirestore(app);

// Enable local persistence
setPersistence(auth, browserLocalPersistence).catch(console.error);

EOF_BACKEND_FILE
mkdir -p "backend-project"
cat << 'EOF_BACKEND_FILE' > "backend-project/.env.example"
# GEMINI_API_KEY: Required for Gemini AI API calls.
# AI Studio automatically injects this at runtime from user secrets.
# Users configure this via the Secrets panel in the AI Studio UI.
GEMINI_API_KEY="MY_GEMINI_API_KEY"

# APP_URL: The URL where this applet is hosted.
# AI Studio automatically injects this at runtime with the Cloud Run service URL.
# Used for self-referential links, OAuth callbacks, and API endpoints.
APP_URL="MY_APP_URL"

EOF_BACKEND_FILE
mkdir -p "backend-project"
cat << 'EOF_BACKEND_FILE' > "backend-project/server.ts"
import express from 'express';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';

import { authRouter } from './src/api/routes/authRoutes.ts';
import { userRouter } from './src/api/routes/userRoutes.ts';
import { xuiRouter } from './src/api/routes/xuiRoutes.ts';
import { threeXuiRouter } from './src/api/routes/threeXuiRoutes.ts';
import { clientRouter } from './src/api/routes/clientRoutes.ts';
import { adminRouter } from './src/api/routes/adminRoutes.ts';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.use('/api/auth', authRouter);
  app.use('/api/users', userRouter);
  app.use('/api/xui', xuiRouter);
  app.use('/api/3xui', threeXuiRouter);
  app.use('/api/client', clientRouter);
  app.use('/api/admin', adminRouter);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend server running on port ${PORT}`);
  });
}

startServer().catch(console.error);

EOF_BACKEND_FILE
mkdir -p "backend-project"
cat << 'EOF_BACKEND_FILE' > "backend-project/tsconfig.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist"
  },
  "include": ["server.ts", "src/**/*"]
}

EOF_BACKEND_FILE
mkdir -p "backend-project"
cat << 'EOF_BACKEND_FILE' > "backend-project/package.json"
{
  "name": "firevpns-backend",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx server.ts",
    "build": "esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs",
    "start": "node dist/server.cjs"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "firebase-admin": "^12.0.0",
    "jsonwebtoken": "^9.0.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.5",
    "@types/node": "^20.10.0",
    "esbuild": "^0.20.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}

EOF_BACKEND_FILE
