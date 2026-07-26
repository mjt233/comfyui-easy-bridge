import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';
import App from './App.vue';
import { router } from './router';

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'light',
    themes: {
      light: {
        colors: {
          primary: '#42A5F5',
          secondary: '#90CAF9',
          accent: '#BBDEFB',
          surface: '#FFFFFF',
          background: '#E3F2FD',
          error: '#EF5350',
          info: '#29B6F6',
          success: '#66BB6A',
          warning: '#FFA726',
        },
      },
    },
  },
});

const app = createApp(App);
app.use(vuetify);
app.use(router);
app.mount('#app');
