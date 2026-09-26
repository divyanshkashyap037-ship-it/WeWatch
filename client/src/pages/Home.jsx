import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';

export default function Home() {
  const [name, setName] = useState(() => localStorage.getItem('wewatchy_name') || '');
  const [roomName, setRoomName] = useState('');
  const [code, setCode] = useState('');
  const nav = useNavigate();

  const create = async () => {
    const n = name.trim() || 'Guest';
    localStorage.setItem('wewatchy_name', n);
    const res = await fetch('/api/rooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: roomName.trim() || 'Movie Night' })
    });
    const data = await res.json();
    nav(`/r/${data.roomId}?name=` + encodeURIComponent(n));
  };

  const join = () => {
    const n = name.trim() || 'Guest';
    localStorage.setItem('wewatchy_name', n);
    const m = code.match(/\/r\/([a-z0-9]+)/i) || code.match(/([a-f0-9]{6})/i);
    const id = m ? m[1] : code.trim();
    if (!id) return alert('Paste invite link or code');
    nav(`/r/${id}?name=` + encodeURIComponent(n));
  };

  return (
    <main className="mx-auto max-w-3xl px-4 pb-20 pt-14 text-center">
      <div className="mx-auto flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs tracking-widest text-white/50">
        BACKED BY <span className="text-[#FF4D00]">✳</span> FRIENDS
      </div>
      <motion.h1
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        className="mt-6 text-5xl font-bold leading-tight md:text-6xl"
      >
        Tasteful Watch Parties,
        <br />Made to Stand Out.
      </motion.h1>
      <p className="mx-auto mt-4 max-w-xl text-white/50">
        YouTube + video files in perfect sync, with face cams and burst emoji reactions.
        Create a room, share the link, done.
      </p>

      <div className="mx-auto mt-8 max-w-md rounded-2xl border border-white/10 bg-white/5 p-5 text-left backdrop-blur">
        <label className="text-xs text-white/50">YOUR NAME</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ahmed" maxLength={30}
          className="mt-1 w-full rounded-xl border border-white/10 bg-black/50 px-3 py-2.5 outline-none placeholder:text-white/25 focus:border-[#FF4D00]" />
        <label className="mt-4 block text-xs text-white/50">ROOM NAME</label>
        <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="Friday Movie Night" maxLength={60}
          className="mt-1 w-full rounded-xl border border-white/10 bg-black/50 px-3 py-2.5 outline-none placeholder:text-white/25 focus:border-[#FF4D00]" />
        <button onClick={create} className="mt-4 w-full rounded-xl bg-[#FF4D00] py-3 font-semibold hover:brightness-110">
          Create room 🍿
        </button>
        <div className="my-4 text-center text-xs text-white/40">— or join friends —</div>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste link or code"
          className="w-full rounded-xl border border-white/10 bg-black/50 px-3 py-2.5 outline-none placeholder:text-white/25 focus:border-[#FF4D00]" />
        <button onClick={join} className="mt-3 w-full rounded-xl border border-white/15 bg-white/10 py-3 font-semibold hover:bg-white/15">
          Join room →
        </button>
      </div>
    </main>
  );
}
