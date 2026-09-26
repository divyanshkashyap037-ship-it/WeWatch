import { Routes, Route, Link } from 'react-router-dom';
import Home from './pages/Home.jsx';
import Room from './pages/Room.jsx';

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <header className="mx-auto mt-4 flex w-fit items-center gap-6 rounded-full border border-white/10 bg-white/5 px-5 py-2 text-sm backdrop-blur">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <span className="text-[#FF4D00]">✳</span> WeWatchy
        </Link>
        <nav className="flex items-center gap-4 text-white/60">
          <Link to="/" className="hover:text-white">Home</Link>
          <span className="text-white/20">|</span>
          <span title="Rooms">Rooms</span>
        </nav>
      </header>
      {children}
    </div>
  );
}

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/r/:roomId" element={<Room />} />
      </Routes>
    </Shell>
  );
}
