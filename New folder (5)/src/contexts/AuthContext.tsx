import React, { createContext, useContext, useState, useEffect } from 'react';
import { onAuthStateChanged, signOut as firebaseSignOut, User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase.ts';

interface User {
  id: string;
  name: string;
  email: string;
  username: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const idToken = await firebaseUser.getIdToken();
        setToken(idToken);
        
        let role = 'customer';
        let fullName = firebaseUser.displayName || 'User';
        
        // Fallback for admin if Firestore isn't enabled yet
        if (firebaseUser.email === 'madushannimesha16@gmail.com') {
          role = 'admin';
          fullName = 'Nimesha Madushan';
        }
        
        try {
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (userDoc.exists()) {
            const data = userDoc.data();
            if (data.role) role = data.role;
            if (data.fullName) fullName = data.fullName;
          }
        } catch (error: any) {
          if (error.code === 'unavailable' || (error.message && error.message.includes('offline'))) {
            console.warn("Client is offline. Proceeding with cached/fallback user data.");
          } else {
            console.error("Error fetching user data:", error);
          }
        }

        setUser({
          id: firebaseUser.uid,
          name: fullName,
          email: firebaseUser.email || '',
          username: firebaseUser.email?.split('@')[0] || '',
          role: role,
        });
      } else {
        setToken(null);
        setUser(null);
      }
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const login = (newToken: string, newUser: User) => {
    // This is now primarily handled by onAuthStateChanged for persistence,
    // but we can still set it immediately for smooth UI transitions
    setToken(newToken);
    setUser(newUser);
  };

  const logout = async () => {
    try {
      await firebaseSignOut(auth);
    } catch (error) {
      console.error("Logout error", error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAuthenticated: !!user, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
