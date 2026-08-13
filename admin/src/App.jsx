import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { SignedIn, SignedOut, RedirectToSignIn, useAuth, useClerk } from '@clerk/clerk-react'
import Layout from './components/Layout'
import { setupApiInterceptors, setupSelfHostedInterceptors } from './lib/api'
import Login from './pages/Login'
import OrderQueue from './pages/OrderQueue'
import Cashier from './pages/Cashier'
import OrderHistory from './pages/OrderHistory'
import MenuManagement from './pages/MenuManagement'
import Ingredients from './pages/Ingredients'
import Tables from './pages/Tables'
import Printers from './pages/Printers'
import Settings from './pages/Settings'

// ── Cloud: Clerk-backed protected layout ──────────────────────────────────────
// Only rendered when ClerkProvider is present (authMode === 'cloud'), so hooks are safe.
function ApiSetup() {
  const { getToken } = useAuth()
  const { openSignIn } = useClerk()
  useEffect(() => setupApiInterceptors({ getToken, openSignIn }), [getToken, openSignIn])
  return null
}

// Clerk hooks throw outside a ClerkProvider, so every call has to live in a
// component that only ever renders in cloud mode. Layout is shared by both
// modes, which is why signing out is handed to it as a prop.
function CloudLayout() {
  const { signOut } = useClerk()
  return <Layout onSignOut={() => signOut()} />
}

function CloudProtectedLayout() {
  return (
    <>
      <SignedIn>
        <ApiSetup />
        <CloudLayout />
      </SignedIn>
      <SignedOut><RedirectToSignIn /></SignedOut>
    </>
  )
}

// ── Self-hosted: localStorage JWT protected layout ────────────────────────────

// Mirrors what the api interceptor does on a 401.
function selfHostedSignOut() {
  localStorage.removeItem('token')
  window.location.href = '/login'
}

function SelfHostedProtectedLayout() {
  useEffect(() => setupSelfHostedInterceptors(), [])
  return localStorage.getItem('token')
    ? <Layout onSignOut={selfHostedSignOut} />
    : <Navigate to="/login" replace />
}

export default function App({ authMode }) {
  const isCloud = authMode === 'cloud'
  return (
    <Routes>
      {!isCloud && <Route path="/login" element={<Login />} />}
      <Route
        path="/"
        element={isCloud ? <CloudProtectedLayout /> : <SelfHostedProtectedLayout />}
      >
        <Route index element={<Navigate to="/orders" replace />} />
        <Route path="orders" element={<OrderQueue />} />
        <Route path="cashier" element={<Cashier />} />
        <Route path="history" element={<OrderHistory />} />
        <Route path="menu" element={<MenuManagement />} />
        <Route path="ingredients" element={<Ingredients />} />
        <Route path="tables" element={<Tables />} />
        <Route path="printers" element={<Printers />} />
        <Route path="settings" element={<Settings authMode={authMode} />} />
      </Route>
    </Routes>
  )
}
