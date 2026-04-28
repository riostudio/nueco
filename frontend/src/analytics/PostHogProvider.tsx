import React, { createContext, useContext, useEffect, useRef, ReactNode } from 'react';
import { 
  initPostHog, 
  identifyUser, 
  resetUser, 
  getPostHog 
} from './posthog';

interface PostHogContextType {
  isInitialized: boolean;
}

const PostHogContext = createContext<PostHogContextType>({ isInitialized: false });

interface PostHogProviderProps {
  children: ReactNode;
  userId?: string;
}

export function PostHogProvider({ children, userId }: PostHogProviderProps) {
  const isInitialized = useRef(false);
  const previousUserId = useRef<string | undefined>(undefined);

  useEffect(() => {
    const initialize = async () => {
      if (!isInitialized.current) {
        await initPostHog(userId);
        isInitialized.current = true;
        previousUserId.current = userId;
        console.log('PostHog provider initialized');
      }
    };
    
    initialize();
  }, []);

  // Handle user identification changes
  useEffect(() => {
    if (!isInitialized.current) return;
    
    // User logged in or changed
    if (userId && userId !== previousUserId.current) {
      identifyUser(userId);
      previousUserId.current = userId;
      console.log('PostHog user identified:', userId);
    }
    // User logged out
    else if (!userId && previousUserId.current) {
      resetUser();
      previousUserId.current = undefined;
      console.log('PostHog user reset');
    }
  }, [userId]);

  return (
    <PostHogContext.Provider value={{ isInitialized: isInitialized.current }}>
      {children}
    </PostHogContext.Provider>
  );
}

export function usePostHogContext() {
  return useContext(PostHogContext);
}
