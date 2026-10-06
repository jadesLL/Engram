import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { vTooltip } from './directives/tooltip';
import { installSystemInsets } from './lib/systemInsets';
import { installBackHandler, installRouterBack } from './lib/androidBack';
import './styles/main.css';
import './styles/settings.css';
// 首页看板模块之间的公共皮肤（抬头 / 卡片 / 行 / 徽章）：跨组件复用，写在全局表里
import './styles/homeBoard.css';

// Android 本地端：接管系统栏安全区与系统返回（侧滑）手势；桌面/网页端是空实现
installSystemInsets();
installBackHandler();
// 路由回退层注册得最早：浮层（抽屉/弹层/阅读目录）先消费，最后才轮到「回上一页」
installRouterBack(router);

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.directive('tooltip', vTooltip);
app.mount('#app');
