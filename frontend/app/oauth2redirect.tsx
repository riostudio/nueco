/**
 * app/oauth2redirect.tsx
 * Match target for the Google OAuth redirect (nueco://oauth2redirect and
 * com.riostudio.memopad:/oauth2redirect). expo-auth-session resolves the pending
 * promptAsync via the linking event; without a matching route, expo-router would park
 * the user on its built-in "Unmatched Route" screen instead of returning to the app.
 */
import { Redirect } from 'expo-router';

export default function OAuthRedirectRoute() {
  return <Redirect href="/" />;
}
