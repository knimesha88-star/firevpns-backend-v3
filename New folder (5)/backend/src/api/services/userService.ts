import { adminDb } from '../../config/firebaseAdmin.js';

export const getUserProfile = async (uid: string): Promise<any> => {
  const userDoc = await adminDb.collection('users').doc(uid).get();
  if (!userDoc.exists) return null;
  return userDoc.data();
};

export const updateUserProfile = async (uid: string, data: any): Promise<void> => {
  await adminDb.collection('users').doc(uid).set(data, { merge: true });
};
