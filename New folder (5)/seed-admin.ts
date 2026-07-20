import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { getFirestore, doc, setDoc, serverTimestamp } from 'firebase/firestore';

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
const auth = getAuth(app);
const db = getFirestore(app);

async function seedAdmin() {
  const email = "madushannimesha16@gmail.com";
  const password = "nimesha@25";
  const name = "Nimesha Madushan";

  let uid;
  let user;

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    user = userCredential.user;
    uid = user.uid;
    console.log("Admin user already exists in Auth. Updating display name.");
    await updateProfile(user, {
      displayName: name,
    });
  } catch (error: any) {
    if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
      console.log("Creating new admin user in Auth...");
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      user = userCredential.user;
      uid = user.uid;
      await updateProfile(user, {
        displayName: name,
      });
    } else {
      console.error("Error fetching/creating user:", error);
      process.exit(1);
    }
  }

  console.log("Setting Firestore document for admin...");
  await setDoc(doc(db, 'users', uid), {
    uid: uid,
    email: email,
    fullName: name,
    role: "admin",
    status: "active",
    createdAt: serverTimestamp(),
  }, { merge: true });

  console.log("Admin seeded successfully!");
  process.exit(0);
}

seedAdmin().catch(console.error);
