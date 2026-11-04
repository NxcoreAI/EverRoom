// svg 静态资源导入（vite 资源 URL）
declare module '*.svg' {
  const src: string
  export default src
}
