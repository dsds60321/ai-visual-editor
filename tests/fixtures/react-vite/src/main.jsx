import React from 'react';import{createRoot}from'react-dom/client';
function App(){const[count,setCount]=React.useState(0);return <main style={{fontFamily:'sans-serif',padding:48}}><small>REACT / VITE</small><h1>내 작업 공간</h1><p>기존 React 컴포넌트를 선택해 변경을 요청하세요.</p><button onClick={()=>setCount(count+1)}>완료한 작업 {count}</button></main>}createRoot(document.getElementById('root')).render(<App/>);
