import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.secondbrain.memoryos',
  appName: 'SECOND BRAIN',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#090a0f',
      showSpinner: false,
    },
  },
};

export default config;
