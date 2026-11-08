'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './production.module.css';

/** One bounded sheet viewport: its headings and horizontal control stay visible. */
export function ProductionTableViewport({children,label='Full amb desplaçament'}:{children:ReactNode;label?:string}) {
  const viewport=useRef<HTMLDivElement>(null);
  const [horizontal,setHorizontal]=useState({position:0,maximum:0});
  useEffect(()=>{
    const element=viewport.current;if(!element)return;
    const measure=()=>setHorizontal(current=>{
      const maximum=Math.max(0,element.scrollWidth-element.clientWidth),position=Math.min(element.scrollLeft,maximum);
      return current.position===position&&current.maximum===maximum?current:{position,maximum};
    });
    measure();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
    observer?.observe(element);if(element.firstElementChild)observer?.observe(element.firstElementChild);
    window.addEventListener('resize',measure);
    return()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  function scrollTo(position:number){const element=viewport.current;if(!element)return;element.scrollLeft=position;setHorizontal(current=>({...current,position:element.scrollLeft}));}
  return <div className={styles.sheetFrame}>
    <div ref={viewport} className={styles.tableWrap} tabIndex={0} role="region" aria-label={label} onScroll={e=>{const element=e.currentTarget;setHorizontal(current=>current.position===element.scrollLeft?current:{...current,position:element.scrollLeft});}}>{children}</div>
    <div className={styles.horizontalScroll} hidden={horizontal.maximum===0}>
      <button type="button" aria-label={`Desplaçar ${label} a l’esquerra`} disabled={horizontal.position===0} onClick={()=>scrollTo(Math.max(0,horizontal.position-200))}>←</button>
      <input type="range" min={0} max={horizontal.maximum} value={horizontal.position} aria-label={`Desplaçament horitzontal: ${label}`} onChange={e=>scrollTo(Number(e.target.value))}/>
      <button type="button" aria-label={`Desplaçar ${label} a la dreta`} disabled={horizontal.position>=horizontal.maximum} onClick={()=>scrollTo(Math.min(horizontal.maximum,horizontal.position+200))}>→</button>
    </div>
  </div>;
}
