import React from 'react';
export function FileCard({children}:{children:React.ReactNode}){return <main className="page-card">{children}</main>}
export function Header({title,fact,intro}:{title:string;fact:string;intro:string}){return <header className="page-header"><p className="header-fact">{fact}</p><h1>{title}</h1><p>{intro}</p></header>}
export function Group({label,children}:{label:string;heading?:boolean;children:React.ReactNode}){return <section className="section"><h2>{label}</h2>{children}</section>}
export function Callout({title,children}:{title:string;children:React.ReactNode}){return <aside className="callout"><strong>{title}</strong><p>{children}</p></aside>}
export function Closing({children}:{children:React.ReactNode}){return <footer className="closing">{children}</footer>}
