/**
 * Prism 的**语言组件**没有类型声明（主包有 @types/prismjs，components/* 没有）。
 * 这里统一声明为副作用模块：我们只 import 它们来注册语言，不使用其导出。
 */
declare module "prismjs/components/*";
