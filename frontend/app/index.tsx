import { Redirect } from 'expo-router';

export default function Index() {
  // Redirect to notes list view as the main entry point
  return <Redirect href="/(tabs)" />;
}
