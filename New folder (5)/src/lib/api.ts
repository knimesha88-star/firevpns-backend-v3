/// <reference types="vite/client" />
// API Helper
import { auth } from './firebase.ts';
import { User } from 'firebase/auth';

const API_URL = import.meta.env.VITE_API_URL || 'https://firevpns-backend-v3.onrender.com/api'

const getCurrentUser = async (): Promise<User | null> => {
  await auth.authStateReady();
  return auth.currentUser;
};

async function fetchWithAuth(endpoint: string, options: RequestInit = {}) {
  let token = null;
  const user = await getCurrentUser();
  
  console.log("Current user:", user?.email);
  
  if (user) {
    token = await user.getIdToken();
    console.log("Firebase token (first 10 chars):", token ? token.substring(0, 10) : 'none');
  } else {
    console.error('[API] fetchWithAuth failed: user is not logged in! Throwing error.');
    throw new Error('Not authenticated');
  }

  const customHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (token) {
    customHeaders['Authorization'] = `Bearer ${token}`;
  }
  
  if (options.headers) {
    Object.assign(customHeaders, options.headers);
  }

  console.log(`[API] Making request to ${API_URL}${endpoint}`);

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: customHeaders,
  });

  console.log(`[API] Response from ${endpoint}: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    let errorData = {};
    try {
      errorData = await response.json();
    } catch (e) {
      console.warn('[API] Could not parse error response JSON');
    }
    
    console.error(`[API] Request to ${endpoint} failed with status ${response.status}. Error data:`, errorData);
    
    if (response.status === 401) {
      console.error('[API] 401 Unauthorized received. Token might be invalid or expired. Throwing error for UI to handle instead of forcing redirect.');
      // Intentionally removed window.location.href = '/login' to avoid redirect loops
    }
    
    throw new Error((errorData as any).error || 'Something went wrong');
  }

  return response.json();
}

export const api = {
  get: (endpoint: string) => fetchWithAuth(endpoint),
  post: (endpoint: string, data: any) => fetchWithAuth(endpoint, { method: 'POST', body: JSON.stringify(data) }),
  put: (endpoint: string, data: any) => fetchWithAuth(endpoint, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (endpoint: string) => fetchWithAuth(endpoint, { method: 'DELETE' }),
};
