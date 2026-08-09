// Inline SVG icons (Lucide-style, 1.8 stroke). No emoji used as icons.
import React from 'react';

const S = ({ children, size = 20, fill = 'none', ...p }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...p}
  >
    {children}
  </svg>
);

export const Send = (p) => (
  <S {...p}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </S>
);
export const Paperclip = (p) => (
  <S {...p}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </S>
);
export const Trash = (p) => (
  <S {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </S>
);
export const Phone = (p) => (
  <S {...p}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" />
  </S>
);
export const PhoneOff = (p) => (
  <S {...p}>
    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
    <line x1="22" y1="2" x2="2" y2="22" />
  </S>
);
export const Video = (p) => (
  <S {...p}>
    <path d="m22 8-6 4 6 4V8Z" />
    <rect x="2" y="6" width="14" height="12" rx="2" />
  </S>
);
export const VideoOff = (p) => (
  <S {...p}>
    <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8" />
    <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </S>
);
export const Mic = (p) => (
  <S {...p}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </S>
);
// The transport either side of play/pause: back to the turn before, on to the
// turn after. A bar against a triangle, which is the one shape everything with a
// track list has used for forty years — no explanation needed, and distinct from
// the plain triangle that means play.
export const SkipBack = (p) => (
  <S {...p}>
    <path d="M18 6 9 12l9 6V6Z" />
    <line x1="6" y1="6" x2="6" y2="18" />
  </S>
);
export const SkipForward = (p) => (
  <S {...p}>
    <path d="m6 6 9 6-9 6V6Z" />
    <line x1="18" y1="6" x2="18" y2="18" />
  </S>
);
// Reading a turn aloud. A speaker with two waves rather than one: one wave is
// the volume glyph used all over this app's sliders, and a button that borrows
// it would read as "set the volume of this message".
export const Speaker = (p) => (
  <S {...p}>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </S>
);
export const MicOff = (p) => (
  <S {...p}>
    <line x1="2" y1="2" x2="22" y2="22" />
    <path d="M18.89 13.23A7 7 0 0 0 19 12v-2" />
    <path d="M5 10v2a7 7 0 0 0 12 5" />
    <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </S>
);
export const Settings = (p) => (
  <S {...p}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
    <circle cx="12" cy="12" r="3" />
  </S>
);
export const Plus = (p) => (
  <S {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </S>
);
export const Minus = (p) => (
  <S {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </S>
);
export const Search = (p) => (
  <S {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </S>
);
export const Refresh = (p) => (
  <S {...p}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </S>
);
// Something to be aware of before carrying on. A triangle rather than a circle,
// which is the shape the rest of the world uses for a warning and the reason it
// reads as one without having to be red.
export const Alert = (p) => (
  <S {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </S>
);
// Putting something back the way it was: one arrow curving anticlockwise to
// where it started. Deliberately not Refresh, which goes round and round and
// says "do it again" — this one has a beginning to return to.
export const Restore = (p) => (
  <S {...p}>
    <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
    <path d="M3 3v5h5" />
  </S>
);
export const X = (p) => (
  <S {...p}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </S>
);
export const FileIcon = (p) => (
  <S {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </S>
);
export const Download = (p) => (
  <S {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </S>
);
export const Maximize = (p) => (
  <S {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </S>
);
export const Minimize = (p) => (
  <S {...p}>
    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
  </S>
);
export const Play = (p) => (
  <S {...p}>
    <polygon points="6 3 20 12 6 21 6 3" />
  </S>
);
// Stop: for a loop, which unlike a one-shot has to be told when to end.
export const Stop = (p) => (
  <S {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </S>
);
// Pause: holding a discussion rather than ending it. Two bars against Stop's one
// square, because the difference between them is the whole point — one gives the
// turn back afterwards and the other does not.
export const Pause = (p) => (
  <S {...p}>
    <rect x="7" y="6" width="3.5" height="12" rx="1" />
    <rect x="13.5" y="6" width="3.5" height="12" rx="1" />
  </S>
);
// Walkie-talkie: body, speaker grille, and antenna.
export const Radio = (p) => (
  <S {...p}>
    <rect x="6" y="8" width="12" height="14" rx="2" />
    <path d="M16 8V5.5a1.5 1.5 0 0 1 1.5-1.5H19" />
    <line x1="19" y1="2" x2="19" y2="5" />
    <line x1="9" y1="11.5" x2="15" y2="11.5" />
    <line x1="9" y1="14" x2="15" y2="14" />
    <rect x="10" y="17" width="4" height="2.5" rx="0.6" />
  </S>
);
export const GroupCall = (p) => (
  <S {...p}>
    <path d="M14 8a3 3 0 1 0-4 0" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <rect x="15" y="11" width="8" height="7" rx="1.5" />
    <path d="m23 12.5-2 1.8 2 1.8z" />
  </S>
);
export const Users = (p) => (
  <S {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </S>
);
// Code brackets, for the developer panel.
export const Code = (p) => (
  <S {...p}>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </S>
);
// Stacked sheets: a session is a conversation kept to one side of the others.
export const Sessions = (p) => (
  <S {...p}>
    <rect x="3" y="7" width="14" height="14" rx="2" />
    <path d="M7 4h12a1 1 0 0 1 1 1v12" />
  </S>
);
// Two lines from one — the shape of taking one thing that was said and carrying
// on from there. The standard fork glyph, the way every version-control tool
// draws it: the trunk rises out of the node below and splits to the two above.
// Recognising it costs nothing; a shape of our own would have to be learned.
export const Fork = (p) => (
  <S {...p}>
    <circle cx="6" cy="5.5" r="2.6" />
    <circle cx="18" cy="5.5" r="2.6" />
    <circle cx="12" cy="18.5" r="2.6" />
    <path d="M6 8.1v1.9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8.1" />
    <path d="M12 12v3.9" />
  </S>
);
// Upload: the mirror of Download, arrow going the other way.
export const Upload = (p) => (
  <S {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 8 12 3 17 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </S>
);
// Stepping through what a search found: back up the conversation, and down it.
// A tick, and the empty box it goes in. Used where several things can be chosen
// at once — the agents a session asks — so the two are drawn as a pair: an
// unticked row still shows its box, because a menu where "not chosen" is drawn
// as nothing reads as a menu of things that cannot be chosen.
export const Check = (p) => (
  <S {...p}>
    <polyline points="20 6 9 17 4 12" />
  </S>
);
export const Dot = (p) => (
  <S {...p} fill="currentColor" stroke="none">
    <circle cx="12" cy="12" r="4.5" />
  </S>
);
export const ChevronUp = (p) => (
  <S {...p}>
    <polyline points="18 15 12 9 6 15" />
  </S>
);
export const ChevronDown = (p) => (
  <S {...p}>
    <polyline points="6 9 12 15 18 9" />
  </S>
);
// Keeping a sidebar category open, and letting it fall shut again. The shackle
// is the whole difference between the two, so it is drawn open rather than the
// pair being told apart by colour alone.
export const Lock = (p) => (
  <S {...p}>
    <rect x="3.5" y="11" width="17" height="10" rx="2" />
    <path d="M7.5 11V7a4.5 4.5 0 0 1 9 0v4" />
  </S>
);
export const Unlock = (p) => (
  <S {...p}>
    <rect x="3.5" y="11" width="17" height="10" rx="2" />
    <path d="M7.5 11V7a4.5 4.5 0 0 1 8.9-1" />
  </S>
);
// The handle a category is dragged by. Filled dots rather than rings: at 14px a
// 1.8 stroke around a 1px circle closes up into a blob anyway, and the filled
// version is the one that reads as something to take hold of.
export const Grip = (p) => (
  <S {...p}>
    <g fill="currentColor" stroke="none">
      <circle cx="9" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="15" cy="18" r="1.4" />
    </g>
  </S>
);
// The three Task Bar views. Drawn to be told apart at 20px in a row of three,
// which is the only place they appear: a page with lines on it, a head with a
// signal above it, and a clock face — three silhouettes rather than three
// rectangles with different contents.
export const Note = (p) => (
  <S {...p}>
    <path d="M5 3.5h9.5L19 8v12.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" />
    <path d="M14 3.5V8h5" />
    <path d="M7.5 12.5h8" />
    <path d="M7.5 16.5h5" />
  </S>
);
export const Bot = (p) => (
  <S {...p}>
    <rect x="3.5" y="8" width="17" height="12" rx="3" />
    <path d="M12 8V4.5" />
    <circle cx="12" cy="3.5" r="1.2" />
    <path d="M8.5 13v1.5" />
    <path d="M15.5 13v1.5" />
  </S>
);
export const Clock = (p) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </S>
);
