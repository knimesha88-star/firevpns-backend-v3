import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Flame, Mail, ArrowRight, ArrowLeft } from 'lucide-react';

export const ForgotPassword: React.FC = () => {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: Implement actual password reset API call
    setSubmitted(true);
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center relative overflow-hidden px-4">
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[url('https://photos.fife.usercontent.google.com/pw/AP1GczOvLlhbzq1cgL32Ujm5ThoTSwujtE4ycjwp_jbw0cLa39TpF19RMdaxsA=w1264-h843-s-no-gm?authuser=0')] bg-cover bg-center opacity-20 mix-blend-screen"></div>
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-transparent"></div>
        <div className="absolute inset-0 bg-gradient-to-r from-blue-900/10 to-orange-900/10"></div>
      </div>

      <div className="w-full max-w-md z-10 relative">
        <div className="bg-[#0a0a0f]/80 backdrop-blur-xl border border-white/10 p-8 rounded-3xl shadow-2xl">
          
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500/20 to-red-500/20 border border-orange-500/30 mb-4">
              <Flame className="w-8 h-8 text-orange-500" />
            </div>
            <h1 className="text-3xl font-bold text-white mb-2">Reset Password</h1>
            <p className="text-gray-400">We'll send you instructions to reset it.</p>
          </div>

          {submitted ? (
            <div className="text-center space-y-6">
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm">
                If an account exists for {email}, you will receive a password reset link shortly.
              </div>
              <Link to="/login" className="inline-flex items-center justify-center gap-2 text-white font-medium hover:text-blue-400 transition-colors">
                <ArrowLeft className="w-4 h-4" /> Back to Login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1.5 ml-1">Email Address</label>
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

              <button
                type="submit"
                className="w-full py-3 px-4 bg-white text-black hover:bg-gray-200 font-bold rounded-xl transition-all flex items-center justify-center gap-2"
              >
                Send Reset Link <ArrowRight className="w-4 h-4" />
              </button>

              <div className="text-center pt-4">
                <Link to="/login" className="text-gray-400 text-sm font-medium hover:text-white transition-colors">
                  Cancel
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
