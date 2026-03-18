import { Redirect } from 'expo-router';

export default function Index() {
  // Always redirect to editor for fresh experience
  // If user has notes, they can go to tabs from there
  return <Redirect href="/editor" />;
}
