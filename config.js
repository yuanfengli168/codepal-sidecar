// codepal-sidecar — runtime config.
//
// Per DESIGN.md decision #4 ("no new Firebase project"), this reuses
// AuthKit's existing Firebase project. The apiKey here is the same
// value published in AuthKit's public demo at
//   https://yuanfengli168.github.io/authkit/demo/
// so committing it adds zero new exposure. Per Firebase docs,
// `apiKey` is not a secret — access is gated by Firestore security
// rules + Authorized Domains in Firebase Console.
//
// If you ever want to switch to your own Firebase project, replace
// these six fields and update Authorized Domains accordingly.

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAftuF-eDxWOdIBrHvFE50Qt8X7F9XvLFQ",
  authDomain: "ai-idea-generator-d9e15.firebaseapp.com",
  projectId: "ai-idea-generator-d9e15",
  storageBucket: "ai-idea-generator-d9e15.firebasestorage.app",
  messagingSenderId: "997919258193",
  appId: "1:997919258193:web:8c1ad1f323a82b683faa70",
  measurementId: "G-8JRCF2825J"
};

// Where AuthKit's static assets are hosted. Used as the import root
// for the ES module + provider modules.
export const AUTHKIT_BASE_URL = "https://yuanfengli168.github.io/authkit/";

// Brand text shown in AuthKit's login UI.
export const AUTHKIT_BRAND_NAME = "CodePal Sidecar";
