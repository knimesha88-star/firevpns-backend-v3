import { adminDb } from '../../config/firebaseAdmin.js';

export const getDashboardStats = async (): Promise<any> => {
  const usersSnap = await adminDb.collection('users').count().get();
  return {
    totalUsers: usersSnap.data().count
  };
};

export const getAllUsers = async (): Promise<any[]> => {
  const snap = await adminDb.collection('users').get();
  return snap.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
};
