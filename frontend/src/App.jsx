import { Routes, Route } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { KitchenProvider } from './contexts/KitchenContext'
import Home from './pages/Home'
import Order from './pages/Order'
import TrackOrder from './pages/TrackOrder'

// Cloud / slug-based routes: /k/:slug/*
function KitchenRoutes() {
  return (
    <KitchenProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/order" element={<Order />} />
        <Route path="/track/:publicId" element={<TrackOrder />} />
        <Route path="/track" element={<TrackOrder />} />
      </Routes>
    </KitchenProvider>
  )
}

// Self-hosted direct routes: /order, /track/:publicId
// KitchenProvider uses kitchen_id="default" with no slug lookup.
function DirectKitchenRoutes() {
  return (
    <KitchenProvider fixedKitchenId="default">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/order" element={<Order />} />
        <Route path="/track/:publicId" element={<TrackOrder />} />
        <Route path="/track" element={<TrackOrder />} />
      </Routes>
    </KitchenProvider>
  )
}

function FallbackWelcome() {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-800 mb-2">{t('common.welcome')}</h1>
        <p className="text-gray-500">{t('common.scanAtYourTable')}</p>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/k/:slug/*" element={<KitchenRoutes />} />
      <Route path="/order" element={<DirectKitchenRoutes />} />
      <Route path="/track/*" element={<DirectKitchenRoutes />} />
      <Route path="/" element={<DirectKitchenRoutes />} />
      <Route path="*" element={<FallbackWelcome />} />
    </Routes>
  )
}
