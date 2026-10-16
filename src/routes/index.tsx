import {DiscoveryProductCard} from '@/components/discovery-product-card';
import {parseDiscoveryState,discoveryFacetOptions,discoveryIdentity,hasDiscoveryFilters,priceRange,appendDiscoveryPage,type DiscoveryState} from '@/modules/catalog/public/discovery-state';
import * as Dialog from '@radix-ui/react-dialog';
import { portalHref } from "@/lib/portal-links";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Baby,
  BadgeCheck,
  BookOpen,
  CarFront,
  Cpu,
  HeartPulse,
  House,
  Shirt,
  UtensilsCrossed,
  ShoppingBasket,
  Wheat,
  ChevronRight,
  Grid2X2,
  CircleUserRound,
  Package,
  MapPin,
  Menu,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Truck,
  X,
} from "lucide-react";
import { listMerchants, loadActiveCatalogTaxonomy, searchCatalogProducts, type CatalogSearchPage } from "@/modules/catalog/public/catalog";
import { type CategoryKey } from "@/modules/shared/public/categories";
import { formatGhs } from "@/modules/shared/public/money";
import type { ProductCard } from "@/modules/shared/public/types";
import { addCartLine, readCart } from "@/modules/ordering/public/cart";
import { MerchantWorkspaceLink, SignedIn, SignedOut, UserButton } from "@/modules/identity/public/auth/gates";
import { ContactSupportWidget } from "@/components/contact-support-widget";
import { MarketFooter } from "@/components/market-header";
import { safeImageSource } from "@/modules/shared/public/media";
import { loadHomepageMerchandising, recordHomepageAdEvent } from "../modules/catalog/public/transport/homepage.functions";
import { saveSearch, searchSuggestions } from "@/modules/engagement/public/customer-engagement.functions";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import type { HomepageSection } from "../modules/catalog/public/transport/homepage.functions";

export const Route = createFileRoute("/")({
  validateSearch: parseDiscoveryState,
  head: ({match})=>({meta:[{name:'robots',content:hasDiscoveryFilters(match.search)?'noindex,follow':'index,follow'}],links:[{rel:'canonical',href:'/'},{rel:'manifest',href:'/manifest.webmanifest'}]}),
  loader: async () => {
    const [discovery, merchants, merchandising, taxonomy] = await Promise.all([
      searchCatalogProducts({ data: { limit: 40 } }).catch(()=>null),
      listMerchants({ data: {} }).catch(()=>[]),
      loadHomepageMerchandising({ data: {} }).catch(()=>[]),
      loadActiveCatalogTaxonomy().catch(()=>[]),
    ]);
    return { discovery, merchants, merchandising, taxonomy };
  },
  component: Home,
});

function Home() {
  const { discovery, merchants, merchandising, taxonomy } = Route.useLoaderData();
  const products=discovery?.products??[];
  const activeCategories = taxonomy;
  const state=Route.useSearch();
  const navigate=Route.useNavigate();
  const [query,setQuery]=useState(state.q??'');
  useEffect(()=>setQuery(state.q??''),[state.q]);
  const updateDiscovery=useCallback((patch:Partial<DiscoveryState>,replace=false)=>{void navigate({search:previous=>parseDiscoveryState({...previous,...patch}),replace,resetScroll:false});},[navigate]);
  const category=state.category,subcategory=state.subcategory,brandFilter=state.brand,conditionFilter=state.condition,searchSort=state.sort??'relevance';
  const setSubcategory=(value:string|undefined)=>updateDiscovery({subcategory:value});
  const setBrandFilter=(value:string|undefined)=>updateDiscovery({brand:value});
  const setConditionFilter=(value:DiscoveryState['condition'])=>updateDiscovery({condition:value});
  const setSearchSort=(value:DiscoveryState['sort'])=>updateDiscovery({sort:value});
  const [minPrice,setMinPrice]=useState(state.minPrice==null?'':String(state.minPrice));
  const [maxPrice,setMaxPrice]=useState(state.maxPrice==null?'':String(state.maxPrice));
  const [priceError,setPriceError]=useState<string>();
  useEffect(()=>{setMinPrice(state.minPrice==null?'':String(state.minPrice));setMaxPrice(state.maxPrice==null?'':String(state.maxPrice));setPriceError(undefined);},[state.minPrice,state.maxPrice]);
  const applyPrices=()=>{const range=priceRange(minPrice,maxPrice);setPriceError(range.error);if(!range.error)updateDiscovery({minPrice:range.minPrice,maxPrice:range.maxPrice});};
  const clearDiscovery=()=>{setQuery('');setPriceError(undefined);void navigate({search:parseDiscoveryState({}),resetScroll:false});};
  const {user}=useCurrentUserState();
  const [suggestions,setSuggestions]=useState<string[]>([]);
  const [suggestionStatus,setSuggestionStatus]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  const [searchSaved,setSearchSaved]=useState(false);
  const [saveError,setSaveError]=useState<string>();
  const [catalogResults,setCatalogResults]=useState<ProductCard[]>(hasDiscoveryFilters(state)?[]:products);
  const [catalogLoading,setCatalogLoading]=useState(hasDiscoveryFilters(state));
  const [catalogError,setCatalogError]=useState<string|null>(discovery?null:'Marketplace search is temporarily unavailable. Please retry.');
  const [catalogRetry,setCatalogRetry]=useState(0);
  const [searchMeta,setSearchMeta]=useState<CatalogSearchPage|null>(hasDiscoveryFilters(state)?null:discovery);
  const [suggestionsOpen,setSuggestionsOpen]=useState(false);
  const [activeSuggestion,setActiveSuggestion]=useState(-1);
  const [loadingMore,setLoadingMore]=useState(false);
  const [moreError,setMoreError]=useState<string|null>(null);
  const morePending=useRef(false);
  const searchRequest=useRef(0);
  const firstSearch=useRef(true);
  const stateKey=discoveryIdentity(state),latestStateKey=useRef(stateKey);
  latestStateKey.current=stateKey;
  useEffect(()=>{const timer=window.setTimeout(()=>{if(query.trim()!==(state.q??''))updateDiscovery({q:query.trim()});},250);return()=>window.clearTimeout(timer);},[query,state.q,updateDiscovery]);
  const [cart, setCart] = useState<Record<string, number>>({});
  useEffect(() => {
    const sync = () => {
      setCart(readCart().reduce<Record<string, number>>((totals, line) => { totals[line.productId] = (totals[line.productId] ?? 0) + line.quantity; return totals; }, {}));
    };
    sync();
    window.addEventListener("elemarket:cart-updated", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("elemarket:cart-updated", sync); window.removeEventListener("storage", sync); };
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addedNotice, setAddedNotice] = useState(false);
  const recordAd = (campaignId: string, eventType: "impression" | "click", receipt:string) => {
    if (!campaignId || !receipt) return;
    void recordHomepageAdEvent({ data: { eventId: `${crypto.randomUUID()}${Math.random().toString(36).slice(2, 10)}`, campaignId, eventType, receipt } }).catch(() => undefined);
  };


  useEffect(() => {
    const q=query.trim();
    if(q.length<2){setSuggestionStatus("idle");setSuggestions([]);setSuggestionsOpen(false);setActiveSuggestion(-1);return;}
    let active = true;
    setSuggestionStatus("loading");setActiveSuggestion(-1);
    const timer = window.setTimeout(() => { void searchSuggestions({ data: { q:q.slice(0,80) } }).then(rows => { if (active) { setSuggestions(rows); setSuggestionStatus("ready"); setActiveSuggestion(-1); } }).catch(() => { if (active){setSuggestions([]);setSuggestionStatus("error");} }); }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  },[query]);

  useEffect(()=>{
    const requestId=++searchRequest.current;
    morePending.current=false;setLoadingMore(false);setMoreError(null);
    if(firstSearch.current&&!hasDiscoveryFilters(state)&&discovery){firstSearch.current=false;return;}
    firstSearch.current=false;
    setCatalogLoading(true);setCatalogError(null);setSearchMeta(null);setCatalogResults([]);
    let active=true;
    void searchCatalogProducts({data:{...state,q:state.q,limit:40}}).then(page=>{
      if(!active||latestStateKey.current!==stateKey||searchRequest.current!==requestId)return;
      setCatalogResults(appendDiscoveryPage([],page.products));setSearchMeta(page);
    }).catch(()=>{if(active&&latestStateKey.current===stateKey&&searchRequest.current===requestId)setCatalogError('Marketplace search is temporarily unavailable. Please try again.');})
    .finally(()=>{if(active&&latestStateKey.current===stateKey&&searchRequest.current===requestId)setCatalogLoading(false);});
    return()=>{active=false;};
  },[stateKey,catalogRetry,state,discovery]);
  const visible=catalogResults;
  const interpretationLabels:Record<string,string>={category:'Category',subcategory:'Subcategory',brand:'Brand',minPrice:'Minimum price',maxPrice:'Maximum price',budgetCeiling:'Preferred budget',availability:'In stock',effectiveSort:'Order'};
  const interpretation=Object.entries(searchMeta?.interpretedFilters??{}).filter(([key,value])=>Boolean(interpretationLabels[key])&&value!=null&&value!==false&&value!=='relevance').map(([key,value])=>`${interpretationLabels[key]}: ${value===true?'yes':String(value).replaceAll('_',' ')}`);

  const cartCountValue = Object.values(cart).reduce((a, b) => a + b, 0);
  const selectedCategory = activeCategories.find((c) => c.key === category);

  const selectCategory=(key?:CategoryKey)=>{updateDiscovery({category:key,subcategory:undefined});setMenuOpen(false);};
  const loadMoreResults=async()=>{
    if(!searchMeta?.nextCursor||morePending.current)return;
    const requestId=searchRequest.current,key=stateKey,cursor=searchMeta.nextCursor;
    morePending.current=true;setLoadingMore(true);setMoreError(null);
    try{
      const page=await searchCatalogProducts({data:{...state,limit:40,cursor}});
      if(searchRequest.current!==requestId||latestStateKey.current!==key)return;
      setCatalogResults(current=>appendDiscoveryPage(current,page.products));setSearchMeta(page);
    }catch{if(searchRequest.current===requestId&&latestStateKey.current===key)setMoreError('Could not load more results. Retry, or refresh results if your search has expired.');}
    finally{if(searchRequest.current===requestId&&latestStateKey.current===key){morePending.current=false;setLoadingMore(false);}}
  };

  const addProductToCart = (product: ProductCard) => {
    const next = addCartLine({ productId: product.id, variantId: null, name: product.name, price: product.price, imagePath: product.imagePath, merchantId: product.merchantId, stock: product.stock,attributionReceipt:product.attributionReceipt });
    setCart(next.reduce<Record<string, number>>((totals, line) => { totals[line.productId] = (totals[line.productId] ?? 0) + line.quantity; return totals; }, {}));
    setAddedNotice(true);
    window.setTimeout(() => setAddedNotice(false), 2200);
  };

  return (
    <div className="min-h-screen bg-market-bg text-market-ink">
      <a href="#main-content" className="sr-only z-[70] rounded-lg bg-white px-4 py-2 font-bold text-market-green focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to marketplace content</a>
      <ContactSupportWidget />
      <div className="border-b border-market-green/15 bg-market-green px-4 py-1.5 text-center text-[11px] font-semibold text-white sm:text-xs">Shopping across Ghana · Delivery options and fees confirmed at checkout · Support when you need it</div>
      <header className="sticky top-0 z-40 border-b border-market-line/80 bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-market-line bg-white lg:hidden"
            aria-label="Open categories"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={19} />
          </button>
          <a href="/" className="shrink-0 text-xl font-black tracking-[-0.04em] text-market-green sm:text-2xl">
            ELE<span className="text-market-orange">MARKET</span>
          </a>
          <div className="hidden items-center gap-2 text-sm font-medium text-market-muted lg:flex">
            <MapPin size={16} className="text-market-green" /> Ghana
          </div>
          <label className="relative order-last mx-auto flex min-w-0 basis-full sm:order-none sm:max-w-2xl sm:basis-auto sm:flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-market-muted" size={18} />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value.slice(0,120)); setSuggestionsOpen(true); }}
              onFocus={() => setSuggestionsOpen(true)}
              onBlur={()=>setSuggestionsOpen(false)}
              maxLength={120}
              onKeyDown={(e) => { if(e.key==="Escape"){e.preventDefault();setSuggestionsOpen(false);return;} if(e.key==="Enter"){e.preventDefault();const value=suggestionsOpen&&activeSuggestion>=0?suggestions[activeSuggestion]!:query;setQuery(value);updateDiscovery({q:value.trim()});setSuggestionsOpen(false);return;} if(!suggestionsOpen||!suggestions.length)return; if(e.key==="ArrowDown"){e.preventDefault();setActiveSuggestion(v=>(v+1)%suggestions.length);} else if(e.key==="ArrowUp"){e.preventDefault();setActiveSuggestion(v=>(v<=0?suggestions.length-1:v-1));} else if(e.key==="Enter"&&activeSuggestion>=0){e.preventDefault();setQuery(suggestions[activeSuggestion]!);setSuggestionsOpen(false);} else if(e.key==="Escape"){setSuggestionsOpen(false);} }}
              placeholder="Search products, brands, stores..."
              className="h-11 w-full rounded-2xl border border-market-line bg-market-bg pl-11 pr-4 text-sm outline-none transition placeholder:text-market-muted/80 focus:border-market-green focus:bg-white focus:ring-4 focus:ring-market-green/10"
              aria-activedescendant={suggestionsOpen&&activeSuggestion>=0?`market-suggestion-${activeSuggestion}`:undefined} aria-label="Search marketplace" aria-autocomplete="list" aria-expanded={suggestionsOpen&&suggestionStatus!=="idle"} aria-controls="market-search-suggestions" role="combobox"
            />
            {suggestionsOpen && suggestionStatus!=="idle" && !suggestions.length&&<div role="status" className="absolute left-0 right-0 top-12 z-50 rounded-xl border border-market-line bg-white p-3 text-sm">{suggestionStatus==='loading'?'Loading suggestions…':suggestionStatus==='error'?'Suggestions unavailable. You can still search.':'No suggestions. Press Enter to search.'}</div>}
            {suggestionsOpen && suggestions.length>0 && <div id="market-search-suggestions" role="listbox" className="absolute left-0 right-0 top-12 z-50 overflow-hidden rounded-2xl border border-market-line bg-white py-1 shadow-market-lg">{suggestions.map((value,index)=><button type="button" role="option" aria-selected={index===activeSuggestion} id={`market-suggestion-${index}`} tabIndex={-1} key={value} onMouseDown={e=>e.preventDefault()} onClick={()=>{setQuery(value);updateDiscovery({q:value});setSuggestionsOpen(false);}} className={`flex w-full items-center gap-2 px-4 min-h-11 py-2.5 text-left text-sm ${index===activeSuggestion?"bg-market-soft text-market-green":"hover:bg-market-bg"}`}><Search size={14}/><span className="truncate">{value}</span></button>)}</div>}
          </label>{user&&hasDiscoveryFilters(state)&&<button type="button" onClick={async()=>{try{await saveSearch({data:{name:(query.trim()||brandFilter||category||"Saved browse").slice(0,80),query:{q:query.trim(),category,subcategory,brand:brandFilter,condition:conditionFilter,minPrice:state.minPrice,maxPrice:state.maxPrice,sort:searchSort},notify:true}});setSaveError(undefined);setSearchSaved(true);window.setTimeout(()=>setSearchSaved(false),2000);}catch{setSearchSaved(false);setSaveError("Your search could not be saved. Please retry.");}}} className="inline-flex min-h-11 items-center rounded-xl border border-market-line px-3 text-xs font-bold text-market-green">{searchSaved?"Saved":"Save search"}</button>}
          <div className="hidden items-center gap-2 lg:flex">
            <Link to="/orders" className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-market-muted hover:bg-market-soft"><Package size={17} aria-hidden="true"/>Orders</Link>
            <SignedOut>
              <Link to="/login" className="inline-flex h-10 items-center rounded-xl px-3 text-sm font-semibold text-market-muted hover:bg-market-soft">Sign in</Link>
              <a href={portalHref("seller", "/merchant/login")} className="inline-flex h-10 items-center rounded-xl px-3 text-sm font-semibold text-market-muted hover:bg-market-soft">Merchant login</a>
              <a href={portalHref("seller", "/merchant/register")} className="inline-flex h-10 items-center rounded-xl bg-market-green px-4 text-sm font-bold text-white shadow-sm hover:bg-market-green/90">Become a merchant</a>
            </SignedOut>
            <SignedIn>
              <MerchantWorkspaceLink className="inline-flex h-10 items-center rounded-xl px-3 text-sm font-semibold text-market-green hover:bg-market-soft" />
              <UserButton />
            </SignedIn>
          </div>
          <SignedOut><Link to="/login" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-market-line bg-white text-market-ink lg:hidden" aria-label="Sign in"><CircleUserRound size={19} /></Link></SignedOut>
          <SignedIn><Link to="/profile" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-market-line bg-white text-market-ink lg:hidden" aria-label="My account"><CircleUserRound size={19} /></Link></SignedIn>
          <Link to="/cart" className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-market-line bg-white hover:bg-market-soft" aria-label={`Cart, ${cartCountValue} item${cartCountValue === 1 ? "" : "s"}`}>
            <ShoppingBag size={19} />
            {cartCountValue > 0 && <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-market-orange px-1.5 py-0.5 text-center text-[11px] font-black text-white">{cartCountValue}</span>}
          </Link>
        </div>
        <div className="hidden border-t border-market-line/60 bg-white lg:block">
          <div className="mx-auto flex max-w-[1440px] items-center gap-1 overflow-x-auto px-4 py-2 sm:px-6 lg:px-8">
            <button type="button" aria-pressed={!category} onClick={() => selectCategory()} className={`nav-pill ${!category ? "nav-pill-active" : ""}`}><Grid2X2 size={15} /> All categories</button>
            {activeCategories.slice(0, 10).map((c) => <button type="button" key={c.key} aria-pressed={category===c.key} onClick={() => selectCategory(c.key)} className={`nav-pill ${category === c.key ? "nav-pill-active" : ""}`}>{c.name}</button>)}
            {activeCategories.length > 10 && (
              <button onClick={() => setMenuOpen(true)} className="nav-pill text-market-orange">More <ChevronRight size={15} /></button>
            )}
          </div>
        </div>
      </header>

      <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-market-ink/30"/><Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-[86%] max-w-sm overflow-y-auto bg-white p-5 shadow-2xl">
            <div className="flex items-center justify-between"><Dialog.Title className="text-lg font-bold">Shop categories</Dialog.Title><button onClick={() => setMenuOpen(false)} className="flex min-h-11 min-w-11 items-center justify-center rounded-xl p-2 hover:bg-market-soft" aria-label="Close"><X size={20} /></button></div>
            <div className="mt-4 grid grid-cols-2 gap-2 border-b border-market-line pb-4"><SignedOut><Link onClick={() => setMenuOpen(false)} to="/login" className="rounded-xl border border-market-line px-3 py-3 text-center text-sm font-bold">Sign in</Link><a onClick={() => setMenuOpen(false)} href={portalHref("seller", "/merchant/login")} className="rounded-xl bg-market-soft px-3 py-3 text-center text-sm font-bold text-market-green">Merchant login</a></SignedOut><SignedIn><Link onClick={() => setMenuOpen(false)} to="/profile" className="rounded-xl bg-market-soft px-3 py-3 text-center text-sm font-bold text-market-green">My profile</Link><Link onClick={() => setMenuOpen(false)} to="/orders" className="rounded-xl bg-market-soft px-3 py-3 text-center text-sm font-bold text-market-green">My orders</Link><div className="col-span-2"><MerchantWorkspaceLink className="flex w-full items-center justify-center rounded-xl bg-market-green px-3 py-3 text-center text-sm font-bold text-white" /></div></SignedIn></div>
            <div className="mt-5 grid gap-1">{activeCategories.map((c) => <button key={c.key} onClick={() => selectCategory(c.key)} className="rounded-xl px-3 py-3 text-left text-sm font-semibold hover:bg-market-soft">{c.name}</button>)}</div>
      </Dialog.Content></Dialog.Portal></Dialog.Root>

      <main id="main-content">
        {!hasDiscoveryFilters(state)&&<>
        <section className="mx-auto max-w-[1440px] px-4 pt-5 sm:px-6 lg:px-8 lg:pt-8">
          <div className="hero-surface relative overflow-hidden rounded-[28px] px-6 py-8 text-white sm:px-10 sm:py-12 lg:px-14 lg:py-14">
            <div className="relative z-10 max-w-3xl lg:max-w-[59%]">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[.14em] text-market-mint"><Sparkles size={14} /> Ghana's commerce ecosystem</div>
              <h1 className="max-w-3xl text-4xl font-black leading-[1.02] tracking-[-0.05em] sm:text-6xl lg:text-[4.2rem]">Everything you need.<br /><span className="text-market-mint">One marketplace.</span></h1>
              <p className="mt-5 max-w-2xl text-sm leading-6 text-white/75 sm:text-base">Shop from verified merchants across electronics, home appliances, fashion, food, agriculture, machinery and more — with clear delivery, support, returns and provider-connected services where available.</p>
              <div className="mt-7 flex flex-wrap gap-3">
                <button onClick={() => document.getElementById("catalogue")?.scrollIntoView({ behavior: "smooth" })} className="inline-flex h-11 items-center gap-2 rounded-xl bg-white px-5 text-sm font-black text-market-green shadow-lg hover:bg-market-mint">Explore marketplace <ArrowRight size={17} /></button>
                <button onClick={() => document.getElementById("featured-deals")?.scrollIntoView({ behavior: "smooth" })} className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-5 text-sm font-bold text-white hover:bg-white/15"><Sparkles size={16} /> See today’s picks</button>
              </div>
            </div>
            {products.length > 0 && <div className="relative z-10 mt-7 grid gap-2 border-t border-white/15 pt-5 sm:grid-cols-2 lg:absolute lg:bottom-8 lg:right-8 lg:mt-0 lg:w-[38%] lg:border-0 lg:pt-0">{products.slice(0,2).map(product => <Link key={product.id} to="/products/$id" params={{id:product.id}} className="flex min-w-0 items-center gap-3 rounded-2xl border border-white/15 bg-white/10 p-3 backdrop-blur-md hover:bg-white/15"><div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-white/10">{product.imagePath ? <img src={safeImageSource(product.imagePath) ?? undefined} alt="" loading="lazy" className="h-full w-full object-contain" /> : <div className="grid h-full place-items-center text-[10px] text-white/60">Product</div>}</div><div className="min-w-0"><p className="truncate text-xs font-bold text-white">{product.name}</p><p className="mt-1 truncate text-[10px] text-white/60">{product.merchantName}</p><p className="mt-1 text-xs font-black text-market-mint">{formatGhs(product.price)}</p></div></Link>)}</div>}
            <div className="hero-orb hero-orb-one" /><div className="hero-orb hero-orb-two" />
          </div>
        </section>

        <section className="mx-auto max-w-[1440px] px-4 pt-4 sm:px-6 lg:px-8">
          <div className="rounded-2xl border border-market-line bg-white p-5 shadow-sm sm:flex sm:items-center sm:justify-between sm:gap-6">
            <div>
              <p className="text-xs font-black uppercase tracking-[.14em] text-market-orange">For businesses</p>
              <h2 className="mt-1 text-xl font-black">Register your business on ELEMARKET</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-market-muted">Reach new customers with your own catalogue and seller workspace. Already shop here? Use your existing account to apply.</p>
            </div>
            <a href={portalHref("seller", "/merchant/register")} className="mt-4 inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-market-green px-5 text-sm font-black text-white hover:bg-market-green/90 sm:mt-0">Register as a merchant</a>
          </div>
        </section>

        <section className="mx-auto grid max-w-[1440px] grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-3 sm:px-6 lg:px-8">
          <TrustItem icon={<BadgeCheck />} title="Verified merchants" text={`${merchants.length} stores in the marketplace`} />
          <TrustItem icon={<ShieldCheck />} title="Returns & support" text="Order help, disputes and eligible returns stay inside ELEMARKET" />
          <TrustItem icon={<Truck />} title="Delivery options" text="Compare delivery before you pay" />
        </section>

        </>}
        <section className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex items-end justify-between gap-4"><div><p className="eyebrow">Discover</p><h2 className="section-title">Shop by category</h2></div><span className="text-sm font-semibold text-market-muted" aria-live="polite">{catalogLoading ? "Searching…" : `${visible.length} items`}</span></div>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-10">
            {activeCategories.slice(0, 10).map((c) => <button type="button" key={c.key} aria-pressed={category===c.key} onClick={() => selectCategory(c.key)} className={`category-tile ${category === c.key ? "category-tile-active" : ""}`}><CategoryIcon name={c.key} /><span className="mt-2 block leading-4">{c.name}</span></button>)}
          </div>
          {selectedCategory && selectedCategory.subcategories.length > 0 && <div className="mt-4 flex gap-2 overflow-x-auto pb-1">{selectedCategory.subcategories.map((s) => <button type="button" key={s.key} aria-pressed={subcategory===s.key} onClick={() => setSubcategory(s.key)} className={`subcategory-pill ${subcategory === s.key ? "subcategory-pill-active" : ""}`}>{s.name}</button>)}</div>}
        </section>

        {!hasDiscoveryFilters(state)&&<div id="featured-deals"><HomepageMerchandising sections={merchandising} onAdClick={recordAd} cart={cart} onAdd={addProductToCart} /></div>}

        <section id="catalogue" className="mx-auto max-w-[1440px] px-4 pb-16 sm:px-6 lg:px-8">
          <div className="mb-5 flex items-end justify-between"><div><p className="eyebrow">Marketplace</p><h2 className="section-title">{state.q?"Search results":category ? selectedCategory?.name??category.replaceAll("_"," ") : "Browse products"}</h2></div>{(category || subcategory || query || brandFilter || conditionFilter || minPrice || maxPrice || searchSort!=="relevance") && <button onClick={clearDiscovery} className="min-h-11 px-2 text-sm font-bold text-market-green">Clear all filters</button>}</div>
          {<div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-market-line bg-white p-3">
            <span className="mr-auto text-xs font-semibold text-market-muted">{searchMeta?.totalExact ? `${searchMeta.total} results` : `${Math.max(catalogResults.length,searchMeta?.total??0)}+ results`}{searchMeta?.interpretedQuery.degraded ? " · basic search mode" : ""}{searchMeta?.facetsSampled ? " · filter counts are estimates" : ""}</span>
            {(searchMeta?.facets.brand??[]).slice(0,6).map(f=><button key={f.value} type="button" onClick={()=>setBrandFilter(brandFilter===f.value?undefined:f.value)} className={`rounded-full border px-3 py-2.5 text-xs font-bold ${brandFilter===f.value?"border-market-green bg-market-green text-white":"border-market-line bg-white text-market-muted"}`}>{f.value} <span className="opacity-70">{f.count}</span></button>)}
            <select aria-label="Product condition" value={conditionFilter??""} onChange={e=>setConditionFilter((e.target.value||undefined) as typeof conditionFilter)} className="min-h-11 rounded-xl border border-market-line bg-white px-3 text-xs font-bold text-market-ink"><option value="">Any condition</option>{discoveryFacetOptions(searchMeta?.facets.condition??[],conditionFilter).map(f=><option key={f.value} value={f.value}>{f.value.replaceAll("_"," ")} ({f.count})</option>)}</select>
            <label className="sr-only" htmlFor="min-price">Minimum price</label><input id="min-price" inputMode="decimal" value={minPrice} onChange={e=>setMinPrice(e.target.value.replace(/[^0-9.]/g,""))} placeholder="Min GHS" className="min-h-11 w-24 rounded-xl border border-market-line px-3 text-xs"/>
            <label className="sr-only" htmlFor="max-price">Maximum price</label><input id="max-price" inputMode="decimal" value={maxPrice} onChange={e=>setMaxPrice(e.target.value.replace(/[^0-9.]/g,""))} placeholder="Max GHS" className="min-h-11 w-24 rounded-xl border border-market-line px-3 text-xs"/>
            <button type="button" onClick={applyPrices} className="min-h-11 rounded-xl border border-market-line px-3 text-xs font-bold">Apply prices</button>
            <select aria-label="Sort search results" value={searchSort} onChange={e=>setSearchSort(e.target.value as typeof searchSort)} className="min-h-11 rounded-xl border border-market-line bg-white px-3 text-xs font-bold text-market-ink">
              <option value="relevance">Best match</option><option value="newest">Newest</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option>
            </select>
          </div>}
          {priceError&&<p role="alert" className="mb-3 text-sm text-red-700">{priceError}</p>}
          {saveError&&<p role="alert" className="mb-3 text-sm text-red-700">{saveError}</p>}
          {hasDiscoveryFilters(state)&&<div className="mb-3 flex flex-wrap gap-2" aria-label="Active filters">{Object.entries(state).filter(([,v])=>v!==undefined).map(([key,value])=><button key={key} type="button" onClick={()=>{if(key==='q')setQuery('');updateDiscovery({[key]:undefined,...(key==='category'?{subcategory:undefined}:{})});}} className="min-h-11 max-w-full rounded-full border border-market-line bg-white px-3 text-xs">Remove {key}: <span className="break-all">{String(value)}</span> ×</button>)}</div>}
          {searchMeta&&(searchMeta.interpretedQuery.effectiveQuery||interpretation.length>0||Boolean(searchMeta.interpretedQuery.attributes?.length))&&<div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-market-muted" aria-live="polite"><span className="font-bold text-market-ink">ELEMARKET understood:</span>{searchMeta.interpretedQuery.effectiveQuery&&<span className="rounded-full bg-market-soft px-2.5 py-1">{searchMeta.interpretedQuery.effectiveQuery}</span>}{interpretation.map(label=><span key={label} className="rounded-full bg-market-soft px-2.5 py-1">{label}</span>)}{searchMeta.interpretedQuery.attributes?.map(attribute=><span key={attribute.key} className="rounded-full bg-market-soft px-2.5 py-1">{attribute.key.replaceAll('_',' ')}: {attribute.value}{attribute.hard?' (required)':' (preferred)'}</span>)}</div>}
          {catalogError ? <div role="alert" className="rounded-3xl border border-red-200 bg-red-50 p-8 text-center"><p className="text-sm font-bold text-red-800">{catalogError}</p><button type="button" onClick={() => setCatalogRetry((value) => value + 1)} className="market-btn-primary mt-3">Retry search</button></div> : catalogLoading ? <CatalogueSkeleton /> : visible.length === 0 ? <EmptyState onReset={clearDiscovery} /> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{visible.map((product) => <DiscoveryProductCard key={product.id} product={product} quantity={cart[product.id] ?? 0} onAdd={() => addProductToCart(product)} />)}</div>}
          {moreError&&<p role="alert" className="mt-4 text-sm text-red-700">{moreError}<button type="button" className="ml-2 min-h-11 underline" onClick={()=>setCatalogRetry(v=>v+1)}>Refresh results</button></p>}
          {!catalogLoading && !catalogError && searchMeta?.nextCursor && <div className="mt-6 flex justify-center"><button type="button" disabled={loadingMore} onClick={()=>void loadMoreResults()} className="min-h-11 rounded-xl border border-market-green px-5 text-sm font-black text-market-green hover:bg-market-green hover:text-white disabled:cursor-wait disabled:opacity-50">{loadingMore?"Loading…":"Load more"}</button></div>}
        </section>
      </main>
      {addedNotice && cartCountValue > 0 && <div className="fixed inset-x-3 bottom-3 z-50 sm:hidden"><Link to="/cart" className="flex min-h-14 items-center justify-between rounded-2xl bg-market-ink px-4 py-3 text-white shadow-2xl"><span className="text-sm font-bold"><ShoppingBag size={17} className="mr-2 inline" />Added to cart · {cartCountValue} item{cartCountValue === 1 ? "" : "s"}</span><span className="rounded-xl bg-market-orange px-3 py-2 text-xs font-black">View cart</span></Link></div>}

      <MarketFooter />
    </div>
  );
}

function FlashSaleCountdown({ endsAt }: { endsAt?: string }) {
  const [remaining,setRemaining]=useState<string|null>(null);
  useEffect(()=>{ if(!endsAt)return; const update=()=>{ const ms=Math.max(0,new Date(endsAt).getTime()-Date.now()); const sec=Math.floor(ms/1000); const h=Math.floor(sec/3600); const m=Math.floor((sec%3600)/60); const ss=sec%60; setRemaining(ms<=0?"Ended":`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`); }; update(); const timer=window.setInterval(update,1000); return()=>window.clearInterval(timer); },[endsAt]);
  return remaining?<span className="rounded-lg bg-market-ink px-2.5 py-1.5 text-xs font-black tabular-nums text-white">Ends in {remaining}</span>:null;
}

function HomepageMerchandising({ sections,onAdClick,cart,onAdd }: { sections:HomepageSection[]; onAdClick:(id:string,type:"impression"|"click",receipt:string)=>void; cart:Record<string,number>; onAdd:(product:ProductCard)=>void }) {
  return <>{sections.map(section=>{ if(!section.items.length)return null; const flash=section.key==="flash_sales"; const official=section.key==="official_stores"; return <section key={section.key} className={`mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 ${section.mobileVisible===false?"hidden sm:block":""} ${section.desktopVisible===false?"sm:hidden":""}`}><div className={`mb-4 flex flex-wrap items-end justify-between gap-3 ${flash?"rounded-2xl bg-market-orange px-4 py-3 text-white":""}`}><div><p className={flash?"text-[11px] font-black uppercase tracking-[.14em] text-white/80":"eyebrow"}>{section.eyebrow??"Discover"}</p><h2 className={flash?"text-xl font-black sm:text-2xl":"section-title"}>{section.title}</h2></div><div className="flex items-center gap-3">{flash?<FlashSaleCountdown endsAt={section.items[0]?.saleEndsAt}/>:null}<a href="#catalogue" className={`inline-flex items-center gap-1 text-sm font-bold ${flash?"text-white":"text-market-green"}`}>Browse catalogue <ArrowRight size={15}/></a></div></div><div className={flash?"flex snap-x gap-3 overflow-x-auto pb-2":"grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"}>{section.items.map(product=><div key={`${section.key}:${product.id}:${product.adId??"organic"}`} className={flash?"w-[72vw] max-w-[230px] shrink-0 snap-start sm:w-[230px]":"min-w-0"}><DiscoveryProductCard product={product} quantity={cart[product.id]??0} sponsored={Boolean(product.sponsored)} officialStore={official} originalPrice={product.originalPrice} adTitle={product.adTitle} adSubtitle={product.adSubtitle} onAdClick={product.adId?()=>onAdClick(product.adId!,"click",product.adReceipt??""):undefined} onAdImpression={product.adId?()=>onAdClick(product.adId!,"impression",product.adReceipt??""):undefined} onAdd={()=>onAdd(product)}/></div>)}</div></section>; })}</>;
}

function TrustItem({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="flex items-center gap-3 rounded-2xl border border-market-line bg-white p-4"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-market-soft text-market-green">{icon}</div><div><p className="text-sm font-extrabold">{title}</p><p className="text-xs text-market-muted">{text}</p></div></div>; }
function EmptyState({onReset}:{onReset:()=>void}) { return <div className="rounded-3xl border border-dashed border-market-line bg-white p-14 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-market-soft text-market-green"><Search size={21} /></div><h3 className="mt-4 text-lg font-bold">Nothing matched</h3><p className="mt-2 text-sm text-market-muted">Try another search, remove a filter, or browse all products.</p><button type="button" onClick={onReset} className="mt-4 min-h-11 rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white">Reset search</button></div>; }


function CatalogueSkeleton() {
  return <div role="status" aria-label="Loading marketplace products" aria-busy="true">
    <span className="sr-only">Searching the marketplace…</span>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-hidden="true">
      {Array.from({ length: 10 }, (_, index) => <div key={index} className="overflow-hidden rounded-2xl border border-market-line bg-white p-3">
        <div className="market-skeleton aspect-square w-full" />
        <div className="market-skeleton mt-4 h-4 w-4/5" />
        <div className="market-skeleton mt-2 h-4 w-3/5" />
        <div className="market-skeleton mt-6 h-6 w-1/2" />
        <div className="market-skeleton mt-3 h-11 w-full" />
      </div>)}
    </div>
  </div>;
}

const CATEGORY_ICONS = {
  food: UtensilsCrossed, restaurants: UtensilsCrossed, groceries: ShoppingBasket,
  electronics: Cpu, fashion: Shirt, beauty: Sparkles, home: House,
  agriculture: Wheat, automotive: CarFront, health: HeartPulse,
  hospitality: House, "baby-kids": Baby, "books-media": BookOpen,
} satisfies Record<string, typeof ShoppingBag>;
function CategoryIcon({ name }: { name: string }) {
  const Icon = CATEGORY_ICONS[name as keyof typeof CATEGORY_ICONS] ?? ShoppingBag;
  return <Icon size={23} strokeWidth={1.8} aria-hidden="true" />;
}
