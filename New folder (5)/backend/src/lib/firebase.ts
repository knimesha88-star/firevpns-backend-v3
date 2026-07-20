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
