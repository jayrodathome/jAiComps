// --- Helper functions for creating HTML elements ---

/**
 * Creates a standard card element with a title and optional section-level details button.
 * @param {string} title - The title to display in an <h2> tag.
 * @param {object} [opts]
 * @param {boolean} [opts.addDetailsButton=false] - Whether to add a top-level Get Details button.
 * @returns {{card: HTMLDivElement, detailsButton: HTMLButtonElement|null}} The created card and optional button.
 */
const createCard = (title, opts = {}) => {
  const card = document.createElement('div');
  card.className = 'card section';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';
  const cardTitle = document.createElement('h2');
  cardTitle.textContent = title;
  cardTitle.style.flex = '1';
  header.appendChild(cardTitle);

  let detailsButton = null;
  if (opts.addDetailsButton) {
    detailsButton = document.createElement('button');
    detailsButton.type = 'button';
    detailsButton.textContent = 'Details';
    detailsButton.className = 'section-details-btn';
    header.appendChild(detailsButton);
  }

  card.appendChild(header);
  return { card, detailsButton };
};

/**
 * Creates a list of items from an array of objects with name and distance.
 * @param {Array<object>} items - Array of items, each with { name: string, distance_mi: number }.
 * @returns {string} A comma-separated string of items.
 */
const formatNamedList = (items) => {
  if (!items || items.length === 0) return 'N/A';
  return items.map(item => `${item.name} (${item.distance_mi} mi)`).join(', ');
};

async function getPlaceDetails(placeName, address, button) {
  button.disabled = true;
  button.textContent = 'Loading...';

  try {
    const response = await fetch('/api/getPlaceDetails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ placeName, address }),
    });

    if (!response.ok) {
      throw new Error(`Server error! Status: ${response.status}`);
    }

  const data = await response.json();
  button.textContent = '✓';
  button.classList.add('mini-btn-done');
  const span = document.createElement('span');
  span.className = 'inline-details';
  span.innerHTML = `${data.distance} • ${data.duration} • ${data.direction} • <a href="${data.url}" target="_blank">Map</a>`;
  button.insertAdjacentElement('afterend', span);

  } catch (error) {
    console.error('Fetch error:', error);
    button.textContent = 'Error';
  }
}

/**
 * Renders all property data into the container.
 * @param {HTMLElement} container - The element to render the cards into.
 * @param {object} data - The full property details JSON object.
 */
const renderPropertyData = (container, data) => {
  // Clear any previous content
  container.innerHTML = '';

  // Generic function to render a section card
  const renderSection = (title, contentRenderer, sectionData, options = {}) => {
    if (!sectionData) return;
    const { card, detailsButton } = createCard(title, { addDetailsButton: options.addDetailsButton });
    const content = contentRenderer(sectionData, { card, detailsButton });
    content.forEach(el => card.appendChild(el));
    if (detailsButton && options.onDetails) {
      detailsButton.addEventListener('click', () => options.onDetails({ card, button: detailsButton, sectionData }));
    }
    container.appendChild(card);
  };

  // --- Render all sections using the data ---

  // Address card removed per UI simplification request; address still used internally for place detail lookups.

  if (data.amenities_access) renderSection('Amenities Access', (d, { card, detailsButton }) => {
    const scoresDiv = document.createElement('div');
    scoresDiv.className = 'score-grid';
    scoresDiv.innerHTML = `
      <div class="score-box"><strong>Walk Score</strong><div class="score-value">${d.walk_score}</div></div>
      <div class="score-box"><strong>Transit Score</strong><div class="score-value">${d.transit_score}</div></div>
      <div class="score-box"><strong>Bike Score</strong><div class="score-value">${d.bike_score}</div></div>`;

    const ul = document.createElement('ul');
    const notable = d.notable_amenities || {};
    const amenityCategories = {
      "Supermarkets": notable.supermarkets,
      "Pharmacies": notable.pharmacies,
      "Hospitals": notable.hospitals,
      "Senior Centers": notable.senior_centers,
      "Shopping Districts": notable.shopping_business_districts,
      "Parks": notable.parks
    };

    // Build list items with truncated inline then later we'll append tables after details fetch
    for (const [category, items] of Object.entries(amenityCategories)) {
      if (!Array.isArray(items) || !items.length) continue;
      const li = document.createElement('li');
      li._items = items; // store full items array for later
      li.dataset.category = category;
      const first = items.slice(0,4);
      li.innerHTML = `<strong>${category}:</strong> ${first.map(it=>`${it.name} (${it.distance_mi} mi)`).join(', ')}${items.length>4?' …':''}`;
      ul.appendChild(li);
    }

    return [scoresDiv, ul];
  }, data.amenities_access, {
    addDetailsButton: true,
    onDetails: async ({ card, button, sectionData }) => {
      if (card.dataset.detailsLoaded) return; // prevent duplicate fetch
      button.disabled = true; const original = button.textContent; button.textContent = 'Loading...';
      const address = data.address;

      async function fetchPlaceDetails(placeName) {
        try {
          const r = await fetch('/api/getPlaceDetails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeName, address }) });
          if (!r.ok) throw new Error('bad status');
          return await r.json();
        } catch (e) {
          console.warn('Details fetch failed for', placeName, e);
          return null;
        }
      }

      const listItems = Array.from(card.querySelectorAll('ul > li'));
      for (const li of listItems) {
        const items = li._items || [];
        if (!items.length) continue;
        const detailPromises = items.map(it => fetchPlaceDetails(it.name));
        const detailsArr = await Promise.all(detailPromises);
        // Clear inline names so only category label remains
        li.innerHTML = `<strong>${li.dataset.category}:</strong>`;
        const table = document.createElement('table');
        table.className = 'amenity-details-table narrow-table';
        table.style.marginTop = '4px';
  table.innerHTML = `<thead><tr><th>Name</th><th>Dist</th><th>Drive</th><th>Duration</th><th>Dir</th><th>Map</th></tr></thead>`;
        const tbody = document.createElement('tbody');
        items.forEach((item, idx) => {
          const det = detailsArr[idx];
          const tr = document.createElement('tr');
          const driveDist = det?.distance || '—';
            const duration = det?.duration || '—';
            const direction = det?.direction || '—';
            const mapLink = det?.url ? `<a href="${det.url}" target="_blank">Map</a>` : '—';
          tr.innerHTML = `<td>${item.name}</td><td>${item.distance_mi ?? '—'}</td><td>${driveDist}</td><td>${duration}</td><td>${direction}</td><td>${mapLink}</td>`;
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        li.appendChild(table);
      }
      card.dataset.detailsLoaded = '1';
      button.textContent = 'Loaded ✓';
      button.classList.add('mini-btn-done');
    }
  });

  if (data.commute) renderSection('Commute', (d) => {
    const transit = d.transit || {};
    const busAccess = document.createElement('p');
    busAccess.innerHTML = `<strong>Bus Access:</strong> ${transit.bus_access || 'N/A'}`;

    const majorRoutes = document.createElement('p');
    const routes = Array.isArray(transit.major_routes) ? transit.major_routes : [];
    majorRoutes.innerHTML = `<strong>Major Routes:</strong> ${routes.join(', ') || 'N/A'}`;

    const ul = document.createElement('ul');
    const driveTimes = (transit && transit.drive_times) || {};
    Object.entries(driveTimes).forEach(([key, details]) => {
      const prettyName = key
        .replace(/_/g, ' ')
        .replace(/\b(\w)/g, c => c.toUpperCase());
      const li = document.createElement('li');
      const dm = details && details.drive_min !== undefined ? details.drive_min : 'N/A';
      const mi = details && details.drive_mi !== undefined ? details.drive_mi : 'N/A';
      li.innerHTML = `<strong>${prettyName}:</strong> ${dm} min (${mi} mi)`;
      ul.appendChild(li);
    });
    return [busAccess, majorRoutes, ul];
  }, data.commute);

  if (data.schools) renderSection('Schools', (d) => {
    const ul = document.createElement('ul');
    const schoolLevels = { "Elementary": d.elementary, "Middle": d.middle, "High": d.high };
    for (const [level, details] of Object.entries(schoolLevels)) {
      const li = document.createElement('li');
      li._school = details;
      li.dataset.level = level;
      li.innerHTML = `<strong>${level}:</strong> ${details.name} (${details.distance_mi} mi)`;
      ul.appendChild(li);
    }
    return [ul];
  }, data.schools, {
    addDetailsButton: true,
    onDetails: async ({ card, button }) => {
      if (card.dataset.detailsLoaded) return;
      button.disabled = true; const original = button.textContent; button.textContent = 'Loading...';
      const address = data.address;
      async function fetchPlaceDetails(placeName) {
        try {
          const r = await fetch('/api/getPlaceDetails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placeName, address }) });
          if (!r.ok) throw new Error('bad status');
          return await r.json();
        } catch (e) { return null; }
      }
      const ulEl = card.querySelector('ul');
      const lis = Array.from(ulEl.querySelectorAll('li'));
      const table = document.createElement('table');
      table.className = 'school-details-table narrow-table';
      table.style.marginTop = '8px';
  table.innerHTML = `<thead><tr><th>School</th><th>Dist</th><th>Drive</th><th>Duration</th><th>Dir</th><th>Map</th></tr></thead>`;
      const tbody = document.createElement('tbody');
      const labelMap = { Elementary: 'elementary', Middle: 'middle school', High: 'high school' };
      for (const li of lis) {
        const sch = li._school;
        const det = await fetchPlaceDetails(sch.name);
        const simpleName = `${sch.name} (${labelMap[li.dataset.level] || li.dataset.level.toLowerCase()})`;
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${simpleName}</td><td>${sch.distance_mi ?? '—'}</td><td>${det?.distance || '—'}</td><td>${det?.duration || '—'}</td><td>${det?.direction || '—'}</td><td>${det?.url ? `<a href='${det.url}' target='_blank'>Map</a>` : '—'}</td>`;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      // Remove the original level list entirely
      if (ulEl) ulEl.remove();
      card.appendChild(table);
      card.dataset.detailsLoaded = '1';
      button.textContent = 'Loaded ✓';
      button.classList.add('mini-btn-done');
    }
  });

  if (data.crime) renderSection('Crime', (d) => {
    const elements = [];
    if (d.context) {
      const context = document.createElement('p');
      context.textContent = d.context;
      elements.push(context);
    }
    if (d.trend) {
      const trend = document.createElement('p');
      trend.innerHTML = `<em>${d.trend}</em>`;
      elements.push(trend);
    }
    if (d.stats) {
      if (d.stats.note) {
        const note = document.createElement('p');
        note.innerHTML = `<em>${d.stats.note}</em>`;
        elements.push(note);
      } else {
        const heading = document.createElement('p');
        const loc = d.stats.level === 'city' && d.stats.city ? `${d.stats.city}, ${d.stats.state}` : d.stats.state;
        heading.innerHTML = `<strong>FBI Crime Data (${loc} – ${d.stats.year})</strong>`;
        if (d.stats.level === 'city' && d.stats.note) {
          const note = document.createElement('p');
          note.innerHTML = `<em>${d.stats.note}</em>`;
          elements.push(note);
        }
        elements.push(heading);
        const table = document.createElement('table');
        table.className = 'crime-table';
        const rows = [
          ['Violent Crime', d.stats.violent_crime, d.stats.violent_rate_per_100k],
          ['  Homicide', d.stats.homicide, null],
          ['  Robbery', d.stats.robbery, null],
          ['  Aggravated Assault', d.stats.aggravated_assault, null],
          ['Property Crime', d.stats.property_crime, d.stats.property_rate_per_100k],
          ['  Burglary', d.stats.burglary, d.stats.burglary_rate_per_100k],
            ['  Larceny', d.stats.larceny, d.stats.larceny_rate_per_100k],
          ['  Motor Vehicle Theft', d.stats.motor_vehicle_theft, d.stats.motor_vehicle_theft_rate_per_100k],
          ['Arson', d.stats.arson, d.stats.arson_rate_per_100k]
        ];
        table.innerHTML = `
          <thead><tr><th>Offense</th><th>Count</th><th>Rate / 100k</th></tr></thead>
          <tbody>
            ${rows.filter(r => r[1] !== undefined && r[1] !== null).map(r => `
              <tr>
                <td>${r[0]}</td>
                <td>${r[1] !== null && r[1] !== undefined ? r[1].toLocaleString() : '—'}</td>
                <td>${r[2] !== null && r[2] !== undefined ? r[2] : '—'}</td>
              </tr>`).join('')}
          </tbody>`;
        elements.push(table);
        const src = document.createElement('p');
        src.className = 'data-source';
        src.innerHTML = `<small>Source: FBI Crime Data Explorer (api.usa.gov) – State-level estimates. Rates computed per 100k population.</small>`;
        elements.push(src);
      }
    }
    return elements;
  }, data.crime);

  if (data.broadband) renderSection('Broadband', (d) => {
    const ul = document.createElement('ul');
    ul.innerHTML = `
      <li><strong>Cable:</strong> ${d.cable.provider} (Up to ${d.cable.max_speed_mbps} Mbps, ${d.cable.coverage_percent}% coverage)</li>
      <li><strong>Fiber:</strong> ${d.fiber.providers.join(', ')} (${d.fiber.availability})</li>
      <li><strong>5G Home:</strong> ${d["5g_home"].join(', ')}</li>
      <li><strong>Satellite:</strong> ${d.satellite.join(', ')}</li>`;
    const notes = document.createElement('p');
    notes.textContent = d.notes;
    return [ul, notes];
  }, data.broadband);

  if (data.environmental_risk) renderSection('Environmental Risk', (d) => {
    const ul = document.createElement('ul');
    ul.innerHTML = `
      <li><strong>Flood Risk:</strong> ${d.flood_risk}</li>
      <li><strong>Fire Risk:</strong> ${d.fire_risk}</li>
      <li><strong>Heat Risk:</strong> ${d.heat_risk}</li>
      <li><strong>Air Quality:</strong> ${d.air_quality}</li>`;
    return [ul];
  }, data.environmental_risk);

  if (data.property_value) {
    renderSection('Surrounding Area Values', (d) => {
      const card = document.createElement('div');
      card.className = 'pv-card';
      // Hero
      const hero = document.createElement('div'); hero.className='pv-hero';
      hero.innerHTML = `<div class="pv-value">${d.zhvi ? ('$'+d.zhvi.toLocaleString()) : '—'}</div><div class="pv-label">Median Home Value (ZHVI)</div>`;
      // Stats grid
      const stats = document.createElement('div'); stats.className='pv-stats';
      const addStat=(label,value,customEl)=>{ const s=document.createElement('div'); s.className='pv-stat'; s.innerHTML=`<div class="label">${label}</div>`; if(customEl){ s.appendChild(customEl); } else { const v=document.createElement('div'); v.className='value'; v.textContent = value ?? '—'; s.appendChild(v); } stats.appendChild(s); };
      // Region (dropdown if options available)
      if (Array.isArray(d.region_options) && d.region_options.length > 1) {
        const select = document.createElement('select'); select.style.fontSize='12px'; select.style.padding='2px 4px'; select.style.border='1px solid #e2e8f0'; select.style.borderRadius='4px';
        d.region_options.forEach(opt=>{ const o=document.createElement('option'); o.value=opt; o.textContent=opt; if(opt===d.region) o.selected=true; select.appendChild(o); });
        select.addEventListener('change', async ()=>{
          const chosen = select.value; select.disabled=true;
          try {
            const r = await fetch('/api/regionValues',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ region: chosen }) });
            if(!r.ok) throw new Error('Region fetch failed');
            const regionData = await r.json();
            // Merge minimal regionData into original d then re-render only this card (simple approach: re-run entire renderPropertyData)
            const currentFull = { ...data, property_value: { ...data.property_value, ...regionData, region_options: d.region_options } };
            renderPropertyData(container, currentFull);
          } catch(e){ console.error(e); select.style.borderColor='red'; }
          finally { select.disabled=false; }
        });
        addStat('Region', null, select);
      } else {
        addStat('Region', d.region || d.zip || '—');
      }
      addStat('Latest Data', d.latest_month || '—');
      addStat('Level', d.type ? d.type.toUpperCase() : '—');
      if (d.distance_miles) addStat('Distance to Metro', `${d.distance_miles} mi`);
      // Derive latest PPSF value (use explicit value or last non-null in series)
      if (d.price_per_sqft) {
        let ppsfVal = d.price_per_sqft.value;
        if ((ppsfVal === undefined || ppsfVal === null) && Array.isArray(d.price_per_sqft.series)) {
          const lastValid = [...d.price_per_sqft.series].reverse().find(p=>p && p.value !== undefined && p.value !== null);
            ppsfVal = lastValid ? lastValid.value : null;
        }
        if (ppsfVal !== undefined && ppsfVal !== null) {
          addStat('Price / SqFt', '$'+ppsfVal.toLocaleString(undefined,{maximumFractionDigits:0}));
        }
      }
      
      // Add new construction sales stat
      if (d.new_construction) {
        let newConVal = d.new_construction.value;
        if ((newConVal === undefined || newConVal === null) && Array.isArray(d.new_construction.series)) {
          const lastValid = [...d.new_construction.series].reverse().find(p=>p && p.value !== undefined && p.value !== null);
          newConVal = lastValid ? lastValid.value : null;
        }
        if (newConVal !== undefined && newConVal !== null) {
          addStat('New Construction', newConVal.toLocaleString() + ' sales');
        }
      }
      
      // Add affordability index stat
      if (d.affordability_index) {
        let affordVal = d.affordability_index.value;
        if ((affordVal === undefined || affordVal === null) && Array.isArray(d.affordability_index.series)) {
          const lastValid = [...d.affordability_index.series].reverse().find(p=>p && p.value !== undefined && p.value !== null);
          affordVal = lastValid ? lastValid.value : null;
        }
        if (affordVal !== undefined && affordVal !== null) {
          const formattedVal = affordVal >= 1000 ? '$' + Math.round(affordVal/1000) + 'K' : '$' + affordVal.toLocaleString();
          addStat('Income Needed', formattedVal);
        }
      }
      
      // Add renter demand index stat
      if (d.renter_demand) {
        let renterVal = d.renter_demand.value;
        if ((renterVal === undefined || renterVal === null) && Array.isArray(d.renter_demand.series)) {
          const lastValid = [...d.renter_demand.series].reverse().find(p=>p && p.value !== undefined && p.value !== null);
          renterVal = lastValid ? lastValid.value : null;
        }
        if (renterVal !== undefined && renterVal !== null) {
          addStat('Renter Demand', renterVal.toFixed(1) + ' index');
        }
      }
      const chartDiv = document.createElement('div'); chartDiv.id = 'propertyValueChart'; chartDiv.className='pv-chart';
      // Chart mode toggle for multiple datasets
      let chartMode = 'value';
      let modeToggle = null;
      const availableModes = ['value'];
      
      if (d.price_per_sqft && d.price_per_sqft.series) availableModes.push('ppsf');
      if (d.new_construction && d.new_construction.series) availableModes.push('newcon');
      if (d.affordability_index && d.affordability_index.series) availableModes.push('afford');
      if (d.renter_demand && d.renter_demand.series) availableModes.push('renter');
      
      if (availableModes.length > 1) {
        modeToggle = document.createElement('div');
        modeToggle.className='pv-mode-toggle';
        availableModes.forEach(m=>{ 
          const btn=document.createElement('button'); 
          btn.type='button'; 
          btn.textContent = m==='value' ? 'Median Value' : 
                           m==='ppsf' ? 'Price / SqFt' : 
                           m==='newcon' ? 'New Construction' :
                           m==='afford' ? 'Affordability' :
                           m==='renter' ? 'Renter Demand' : m;
          if(m===chartMode) btn.classList.add('active'); 
          btn.addEventListener('click',()=>{ 
            if(chartMode===m) return; 
            chartMode=m; 
            Array.from(modeToggle.children).forEach(c=>c.classList.remove('active')); 
            btn.classList.add('active'); 
            renderChart(); 
          }); 
          modeToggle.appendChild(btn); 
        });
        card.appendChild(modeToggle);
      }
      const footer = document.createElement('div'); footer.className='pv-footer';
      const sourceSpan = document.createElement('span'); sourceSpan.textContent = 'Source: Zillow Home Value Index'; footer.appendChild(sourceSpan);
      const refreshBtn = document.createElement('button'); refreshBtn.textContent='Refresh Dataset'; footer.appendChild(refreshBtn);
      const ts = d.dataset_downloaded_at || d.dataset_loaded_at; if (ts) { const dt=new Date(ts); const meta=document.createElement('span'); meta.style.marginLeft='8px'; meta.className='pv-tooltip-inline'; meta.textContent = `Downloaded ${dt.toLocaleDateString()}`; footer.insertBefore(meta, refreshBtn); }
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true; const original=refreshBtn.textContent; refreshBtn.textContent='Refreshing...';
        try { const r=await fetch('/api/refreshZillow',{method:'POST'}); if(!r.ok) throw new Error('Refresh failed'); await r.json(); const input=document.getElementById('address-input'); if(input && input.value.trim()) document.querySelector('#address-form button').click(); else refreshBtn.textContent='Refreshed'; }
        catch(e){ console.error(e); refreshBtn.textContent='Error'; }
        finally { setTimeout(()=>{ refreshBtn.disabled=false; refreshBtn.textContent=original; },3000); }
      });
      card.appendChild(hero); card.appendChild(stats); card.appendChild(chartDiv); card.appendChild(footer);

      // Build yearly series for chart
      function renderChart() {
        if (!(d.yearly && d.yearly.length > 1 && window.ApexCharts)) return;
        let categories, values, label, yAxisConfig;
        
        if (chartMode==='ppsf' && d.price_per_sqft && d.price_per_sqft.series) {
          const series = d.price_per_sqft.series;
          categories = series.map(p=>p.ym);
          values = series.map(p=>p.value);
          label = 'Price / SqFt';
          // Y-axis config for PPSF: show increments of $100
          const maxVal = Math.max(...values.filter(v=>typeof v==='number'));
          const yMax = Math.max(100, Math.ceil(maxVal/100)*100);
          const tickCount = Math.min(10, Math.ceil(yMax/100));
          yAxisConfig = { min:0, max:yMax, tickAmount: tickCount, labels:{ style:{ colors:'#94a3b8', fontSize:'11px' }, formatter:(v)=>'$'+v } };
        } else if (chartMode==='newcon' && d.new_construction && d.new_construction.series) {
          const series = d.new_construction.series;
          categories = series.map(p=>p.ym);
          values = series.map(p=>p.value);
          label = 'New Construction Sales';
          yAxisConfig = { labels:{ style:{ colors:'#94a3b8', fontSize:'11px' }, formatter:(v)=>v.toLocaleString() } };
        } else if (chartMode==='afford' && d.affordability_index && d.affordability_index.series) {
          const series = d.affordability_index.series;
          categories = series.map(p=>p.ym);
          values = series.map(p=>p.value);
          label = 'Income Needed ($)';
          yAxisConfig = { labels:{ style:{ colors:'#94a3b8', fontSize:'11px' }, formatter:(v)=>'$'+(v>=1000?Math.round(v/1000)+'K':v) } };
        } else if (chartMode==='renter' && d.renter_demand && d.renter_demand.series) {
          const series = d.renter_demand.series;
          categories = series.map(p=>p.ym);
          values = series.map(p=>p.value);
          label = 'Renter Demand Index';
          yAxisConfig = { labels:{ style:{ colors:'#94a3b8', fontSize:'11px' }, formatter:(v)=>v.toFixed(1) } };
        } else {
          // Default to median value
          const useMonthly = d.series && d.series.length > 2;
          if (useMonthly) { categories = d.series.map(p=>p.ym); values = d.series.map(p=>p.value); }
          else { categories = d.yearly.map(r=>r.year); values = d.yearly.map(r=>r.zhvi); }
          label = 'Median Value';
          yAxisConfig = { labels:{ style:{ colors:'#94a3b8', fontSize:'11px' }, formatter:(v)=>{ if(v===0) return '$0'; return '$'+(v>=1_000_000?(v/1_000_000).toFixed(1)+'M':(v/1000).toFixed(0)+'K'); } } };
        }
        
        const options = {
          series:[{ name: label, data: values }],
          chart:{ type:'area', height:260, toolbar:{show:false}, zoom:{enabled:false}, animations:{enabled:true}, foreColor:'#9ca3af' },
          stroke:{ curve:'smooth', width:2.2 },
          dataLabels:{ enabled:false },
          xaxis:{ type:'category', categories, tickAmount: Math.min(10, Math.max(4, Math.floor(categories.length/4))), labels:{ rotate:0, style:{ colors:'#94a3b8', fontSize:'11px' }, formatter:(val)=>{ if(val===undefined||val===null) return ''; const s=val.toString(); if(/^\d{4}-\d{2}$/.test(s)) return s.slice(0,4); if(/^\d{4}$/.test(s)) return s; const m = s.match(/(19|20)\d{2}/); return m?m[0]:s; } }, axisBorder:{show:false}, axisTicks:{show:false} },
          yaxis: yAxisConfig,
          grid:{ borderColor:'#374151', strokeDashArray:4 },
          tooltip:{ theme:'dark', x:{ show:false }, marker:{ show:true }, y:{ formatter:(val)=>{ 
            if (chartMode === 'newcon') return val.toLocaleString() + ' sales';
            if (chartMode === 'renter') return val.toFixed(1) + ' index';
            return '$'+val.toLocaleString();
          } } },
          fill:{ type:'gradient', gradient:{ shadeIntensity:1, opacityFrom:0.25, opacityTo:0.05, stops:[0,100] } },
          markers:{ size:0, hover:{size:5} },
          colors:[chartMode==='newcon'?'#3b82f6':chartMode==='afford'?'#f59e0b':chartMode==='renter'?'#8b5cf6':'#22c55e']
        };
        chartDiv.innerHTML='';
        try { const chart=new ApexCharts(chartDiv, options); chart.render(); } catch(e){ console.warn('ApexCharts render failed', e); }
      }
      setTimeout(renderChart,0);
      if (!window.ApexCharts) {
        console.warn('ApexCharts library not loaded when attempting to render property value chart.');
      }
      if (d.note) { const note=document.createElement('div'); note.className='pv-tooltip-inline'; note.textContent=d.note; card.appendChild(note); }
      return [card];
    }, data.property_value);
  }
};

/**
 * Main function to set up event listeners.
 */
const main = () => {
  const form = document.getElementById('address-form');
  const input = document.getElementById('address-input');
  const button = form.querySelector('button');
  const container = document.getElementById('property-list');
  // Google Places details now always available; no toggle checkbox.

  form.addEventListener('submit', async (event) => {
    event.preventDefault(); // Prevent the form from reloading the page
    const address = input.value.trim();
    if (!address) return;

    // Collect selected section checkboxes
    const selected = Array.from(form.querySelectorAll('input[name="sections"]:checked')).map(c=>c.value);

    // Disable the button and show a loading state
    button.disabled = true;
    button.textContent = 'Loading...';

    container.innerHTML = '<p>Loading property details...</p>';

    try {
      // Call our new backend server
      // Timeout handling
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      let response;
      try {
  response = await fetch('/api/getPropertyDetails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ address: address, sections: selected }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(`Server error! Status: ${response.status}`);
      }

      const data = await response.json();
      renderPropertyData(container, data);

    } catch (error) {
  const aborted = error.name === 'AbortError';
  container.innerHTML = `<div style="color: red;"><strong>Failed to load property details:</strong><br>${aborted ? 'Request timed out. Please try again.' : error.message}</div>`;
      console.error('Fetch error:', error);
    } finally {
      // Re-enable the button and restore its text when the operation is complete
      button.disabled = false;
      button.textContent = 'Get Details';
    }
  });
};

// Run the main script after the DOM has fully loaded.
document.addEventListener('DOMContentLoaded', main);
