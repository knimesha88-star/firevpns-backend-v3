/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext.tsx';
import { ThemeProvider } from './contexts/ThemeContext.tsx';
import { ProtectedRoute, AdminRoute } from './components/ProtectedRoute.tsx';
import { Layout } from './components/Layout.tsx';
import { Landing } from './pages/Landing.tsx';
import { Login } from './pages/Login.tsx';
import { Register } from './pages/Register.tsx';
import { ForgotPassword } from './pages/ForgotPassword.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { MyVPN } from './pages/MyVPN.tsx';
import { Configurations } from './pages/Configurations.tsx';
import { Downloads } from './pages/Downloads.tsx';
import { Billing } from './pages/Billing.tsx';
import { Support } from './pages/Support.tsx';
import { Profile } from './pages/Profile.tsx';
import { AdminDashboard } from './pages/AdminDashboard.tsx';

export default function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />

          {/* Protected Routes */}
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/my-vpn" element={<MyVPN />} />
              <Route path="/configurations" element={<Configurations />} />
              <Route path="/downloads" element={<Downloads />} />
              <Route path="/billing" element={<Billing />} />
              <Route path="/support" element={<Support />} />
              <Route path="/profile" element={<Profile />} />
              
              {/* Admin Routes */}
              <Route element={<AdminRoute />}>
                <Route path="/admin" element={<AdminDashboard />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </Router>
    </AuthProvider>
    </ThemeProvider>
  );
}
