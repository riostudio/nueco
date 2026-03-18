import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { authStorage } from '../src/auth';

export default function Index() {
  const [isLoading, setIsLoading] = useState(true);
  const [isFirstLaunch, setIsFirstLaunch] = useState(false);

  useEffect(() => {
    const checkFirstLaunch = async () => {
      try {
        const hasNotes = await authStorage.isFirstNoteSaved();
        setIsFirstLaunch(!hasNotes);
      } catch (error) {
        console.error('Error checking first launch:', error);
      } finally {
        setIsLoading(false);
      }
    };
    checkFirstLaunch();
  }, []);

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#D84315" />
      </View>
    );
  }

  // On first launch, go directly to editor
  // Otherwise, go to tabs (notes list)
  if (isFirstLaunch) {
    return <Redirect href="/editor" />;
  }

  return <Redirect href="/(tabs)" />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FDFBF7',
  },
});
