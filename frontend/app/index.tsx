import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { notesApi } from '../src/api';

export default function Index() {
  const [isLoading, setIsLoading] = useState(true);
  const [hasNotes, setHasNotes] = useState(false);

  useEffect(() => {
    const checkForNotes = async () => {
      try {
        // Check if there are any notes in the database
        const notes = await notesApi.getAll();
        setHasNotes(notes.length > 0);
      } catch (error) {
        console.error('Error checking notes:', error);
        setHasNotes(false);
      } finally {
        setIsLoading(false);
      }
    };
    checkForNotes();
  }, []);

  if (isLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#D84315" />
      </View>
    );
  }

  // If no notes exist, go directly to editor for first-time experience
  // Otherwise, go to tabs (notes list)
  if (!hasNotes) {
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
