import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.tsx';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase.ts';
import { Flame, Lock, Mail, ArrowRight } from 'lucide-react';

export const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      
      let isAdmin = email.toLowerCase() === 'madushannimesha16@gmail.com';
      let fullName = userCredential.user.displayName || 'User';
      let role = 'customer';
      
      try {
        const userDoc = await getDoc(doc(db, 'users', userCredential.user.uid));
        if (userDoc.exists()) {
          const data = userDoc.data();
          if (data.role === 'admin') {
            isAdmin = true;
          }
          if (data.role) role = data.role;
          if (data.fullName) fullName = data.fullName;
        }
      } catch (err) {
        console.error("Error checking role:", err);
      }
      
      if (isAdmin) role = 'admin';

      const token = await userCredential.user.getIdToken();
      
      login(token, {
        id: userCredential.user.uid,
        name: fullName,
        email: userCredential.user.email || '',
        username: userCredential.user.email?.split('@')[0] || '',
        role: role,
      });

      if (isAdmin) {
        navigate('/admin');
      } else {
        navigate('/dashboard');
      }
    } catch (err: any) {
      if (err.code === 'auth/invalid-credential') {
        setError('Invalid email or password.');
      } else {
        setError(err.message || 'Login failed');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center relative overflow-hidden px-4">
      {/* Animated Background */}
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[url('https://photos.fife.usercontent.google.com/pw/AP1GczOvLlhbzq1cgL32Ujm5ThoTSwujtE4ycjwp_jbw0cLa39TpF19RMdaxsA=w1264-h843-s-no-gm?authuser=0')] bg-cover bg-center opacity-20 mix-blend-screen"></div>
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-transparent"></div>
        <div className="absolute inset-0 bg-gradient-to-r from-blue-900/20 to-purple-900/20"></div>
      </div>

      <div className="w-full max-w-md z-10 relative">
        <div className="bg-[#0a0a0f]/80 backdrop-blur-xl border border-white/10 p-8 rounded-3xl shadow-2xl shadow-blue-500/10">
          
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500/20 to-red-500/20 border border-orange-500/30 mb-4">
              <Flame className="w-8 h-8 text-orange-500" />
            </div>
            <h1 className="text-3xl font-bold text-white mb-2">Secure Login</h1>
            <p className="text-gray-400">Welcome back to FIREVPNs</p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm text-center">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1.5 ml-1">Email</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Mail className="w-5 h-5 text-gray-500" />
                </div>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                  placeholder="name@example.com"
                  required
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5 ml-1 mr-1">
                <label className="block text-sm font-medium text-gray-400">Password</label>
                <Link to="/forgot-password" className="text-sm text-blue-400 hover:text-blue-300">Forgot?</Link>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock className="w-5 h-5 text-gray-500" />
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                  placeholder="••••••••"
                  required
                />
              </div>
            </div>
            
            <div className="flex items-center ml-1">
              <input type="checkbox" id="remember" className="w-4 h-4 rounded border-gray-600 text-blue-600 bg-white/5 focus:ring-blue-500 focus:ring-offset-black" />
              <label htmlFor="remember" className="ml-2 text-sm text-gray-400">Remember me</label>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-medium rounded-xl transition-all shadow-lg shadow-blue-500/25 flex items-center justify-center gap-2 disabled:opacity-70"
            >
              {isLoading ? 'Logging in...' : 'Login'} <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <p className="mt-8 text-center text-gray-400 text-sm">
            Don't have an account?{' '}
            <Link to="/register" className="text-white font-medium hover:text-blue-400 transition-colors">
              Get Started
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};
