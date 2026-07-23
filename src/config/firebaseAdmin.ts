import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

let projectId: string | undefined;
let databaseId: string | undefined;

try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    projectId = config.projectId;
    databaseId = config.firestoreDatabaseId;
    console.log(`[FirebaseAdmin] Loaded config from firebase-applet-config.json. Project: ${projectId}, Database: ${databaseId}`);
  }
} catch (e: any) {
  console.error('[FirebaseAdmin] Error loading firebase-applet-config.json:', e.message);
}

if (!getApps().length) {
  console.log('[FirebaseAdmin] Initializing Firebase Admin SDK...');
  
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    console.log('[FirebaseAdmin] Using separate environment variables for credential');
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log('[FirebaseAdmin] Using FIREBASE_SERVICE_ACCOUNT environment variable');
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      console.log(`[FirebaseAdmin] Successfully parsed FIREBASE_SERVICE_ACCOUNT for project: ${serviceAccount.project_id}`);
      initializeApp({
        credential: cert(serviceAccount),
      });
    } catch (e: any) {
      console.error('[FirebaseAdmin] Error parsing FIREBASE_SERVICE_ACCOUNT JSON:', e.message);
      initializeApp();
    }
  } else if (projectId) {
    console.log(`[FirebaseAdmin] Initializing with projectId from config: ${projectId}`);
    initializeApp({
      projectId: projectId
    });
  } else {
    console.log('[FirebaseAdmin] Using Application Default Credentials (ADC)');
    initializeApp();
  }
}

export const adminAuth = getAuth();
export const adminDb = databaseId ? getFirestore(getApps()[0], databaseId) : getFirestore();

console.log("Firebase Admin initialized successfully");
