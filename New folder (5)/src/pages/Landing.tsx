import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { Flame, Shield, Globe, Zap, ArrowRight, Server, Lock, Clock } from 'lucide-react';

export const Landing: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#05060F] text-slate-200 font-sans selection:bg-blue-500/30">
      
      {/* Navbar */}
      <nav className="fixed top-0 inset-x-0 z-50 bg-[#05060F]/80 backdrop-blur-md border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-white italic">
              <span className="text-orange-500 not-italic text-2xl">🔥</span> FIREVPNs
            </span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-xs font-bold uppercase tracking-wider text-slate-400">
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
            <a href="#servers" className="hover:text-white transition-colors">Servers</a>
            <a href="#faq" className="hover:text-white transition-colors">FAQ</a>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/login" className="text-xs font-bold text-slate-400 hover:text-white transition-colors">
              Login
            </Link>
            <Link to="/register" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg transition-all shadow-lg shadow-blue-900/20">
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 lg:pt-40 lg:pb-32 overflow-hidden flex flex-col items-center justify-center min-h-[80vh]">
        {/* Animated Background Gradients */}
        <div className="absolute inset-0 z-0">
          <div className="absolute inset-0 bg-[url('https://photos.fife.usercontent.google.com/pw/AP1GczOvLlhbzq1cgL32Ujm5ThoTSwujtE4ycjwp_jbw0cLa39TpF19RMdaxsA=w1264-h843-s-no-gm?authuser=0')] bg-cover bg-center opacity-20 mix-blend-screen"></div>
          <div className="absolute inset-0 bg-gradient-to-t from-[#05060F] via-[#05060F]/60 to-transparent"></div>
        </div>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-blue-600/10 blur-[100px] rounded-full pointer-events-none"></div>
        
        <div className="max-w-4xl mx-auto px-6 relative z-10 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded bg-white/5 border border-white/10 text-[10px] text-cyan-400 font-bold uppercase tracking-widest mb-6">
              <Shield className="w-3 h-3" /> Military-grade encryption
            </span>
            <h1 className="text-5xl lg:text-7xl font-bold tracking-tight mb-6 text-white">
              Fast. Secure. <br/><span className="text-blue-500">Private VPN.</span>
            </h1>
            <p className="text-sm text-slate-500 max-w-2xl mx-auto mb-10">
              Protect your privacy with high-speed VPN servers around the world. Access any content securely from anywhere.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link to="/register" className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-lg transition-all shadow-lg shadow-blue-900/20 flex items-center gap-2 text-sm">
                Get Started Now <ArrowRight className="w-4 h-4" />
              </Link>
              <Link to="/login" className="px-6 py-3 bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold rounded-lg transition-all text-sm flex items-center">
                Customer Login
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-24 bg-[#0A0C1A] border-t border-white/5 relative overflow-hidden">
        <div className="max-w-6xl mx-auto px-6 relative z-10">
          <div className="text-center mb-16">
            <h2 className="text-2xl font-bold mb-2 text-white">Why Choose FIREVPNs</h2>
            <p className="text-xs text-slate-500 max-w-2xl mx-auto">We provide the most secure and fastest VPN experience, tailored for privacy enthusiasts.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            <div className="p-6 rounded-2xl bg-[#05060F] border border-white/5 hover:border-white/10 transition-colors">
              <div className="w-10 h-10 bg-cyan-950/30 text-cyan-400 rounded-xl flex items-center justify-center mb-4 border border-cyan-900/50">
                <Zap className="w-5 h-5" />
              </div>
              <h3 className="text-lg font-bold mb-2 text-white">Lightning Fast</h3>
              <p className="text-xs text-slate-500 leading-relaxed">Optimized servers on 10Gbps networks ensure you never experience buffering or lag.</p>
            </div>
            <div className="p-6 rounded-2xl bg-[#05060F] border border-white/5 hover:border-white/10 transition-colors">
              <div className="w-10 h-10 bg-purple-950/30 text-purple-400 rounded-xl flex items-center justify-center mb-4 border border-purple-900/50">
                <Lock className="w-5 h-5" />
              </div>
              <h3 className="text-lg font-bold mb-2 text-white">Zero Logs Policy</h3>
              <p className="text-xs text-slate-500 leading-relaxed">We do not track, collect, or share your private data. What you do online is your business.</p>
            </div>
            <div className="p-6 rounded-2xl bg-[#05060F] border border-white/5 hover:border-white/10 transition-colors">
              <div className="w-10 h-10 bg-blue-950/30 text-blue-400 rounded-xl flex items-center justify-center mb-4 border border-blue-900/50">
                <Server className="w-5 h-5" />
              </div>
              <h3 className="text-lg font-bold mb-2 text-white">Modern Protocols</h3>
              <p className="text-xs text-slate-500 leading-relaxed">Supporting VLESS, VMess, and Trojan protocols for maximum security and anti-censorship.</p>
            </div>
          </div>
        </div>
      </section>
      
      {/* Footer */}
      <footer className="py-8 bg-[#05060F] border-t border-white/5 text-center text-[10px] text-slate-600 font-bold tracking-widest uppercase">
        <p>© 2026 FIREVPNs. All rights reserved.</p>
      </footer>
    </div>
  );
};
