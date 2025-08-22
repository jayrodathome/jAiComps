// --- Helper functions for creating HTML elements ---

/**
 * Creates a standard card element with a title.
 * @param {string} title - The title to display in an <h2> tag.
 * @returns {HTMLDivElement} The created card element.
 */
const createCard = (title) => {
  const card = document.createElement('div');
  card.className = 'card section';

  const cardTitle = document.createElement('h2');
  cardTitle.textContent = title;
  card.appendChild(cardTitle);

  return card;
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

    const table = document.createElement('table');
    table.innerHTML = `
      <tr>
        <th>Distance</th>
        <th>Duration</th>
        <th>Direction</th>
        <th>Google Maps</th>
      </tr>
      <tr>
        <td>${data.distance}</td>
        <td>${data.duration}</td>
        <td>${data.direction}</td>
        <td><a href="${data.url}" target="_blank">View on Google Maps</a></td>
      </tr>
    `;

    button.parentNode.replaceChild(table, button);

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
  const renderSection = (title, contentRenderer, sectionData) => {
    if (!sectionData) return;
    const card = createCard(title);
    const content = contentRenderer(sectionData);
    content.forEach(el => card.appendChild(el));
    container.appendChild(card);
  };

  // --- Render all sections using the data ---

  if (data.address) {
    renderSection('Address', (d) => {
      const p = document.createElement('p');
      p.textContent = d;
      return [p];
    }, data.address);
  }

  if (data.amenities_access) renderSection('Amenities Access', (d) => {
    const scoresDiv = document.createElement('div');
    scoresDiv.className = 'score-grid';
    scoresDiv.innerHTML = `
      <div class="score-box"><strong>Walk Score</strong><div class="score-value">${d.walk_score}</div></div>
      <div class="score-box"><strong>Transit Score</strong><div class="score-value">${d.transit_score}</div></div>
      <div class="score-box"><strong>Bike Score</strong><div class="score-value">${d.bike_score}</div></div>`;

    const ul = document.createElement('ul');
    const notable = d.notable_amenities;
    const amenityCategories = {
      "Supermarkets": notable.supermarkets,
      "Pharmacies": notable.pharmacies,
      "Hospitals": notable.hospitals,
      "Senior Centers": notable.senior_centers,
      "Shopping Districts": notable.shopping_business_districts,
      "Parks": notable.parks
    };

    for (const [category, items] of Object.entries(amenityCategories)) {
      const li = document.createElement('li');
      li.innerHTML = `<strong>${category}:</strong> ${formatNamedList(items)}`;
      // Add per-item Get Details buttons for categories likely representing specific places
      if (Array.isArray(items) && items.length && ['Supermarkets','Pharmacies','Hospitals','Parks'].includes(category)) {
        const btnWrap = document.createElement('span');
        btnWrap.style.marginLeft = '6px';
        items.forEach(item => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = 'Get Details';
          b.style.marginLeft = '4px';
          b.addEventListener('click', () => getPlaceDetails(item.name, data.address, b));
          btnWrap.appendChild(b);
        });
        li.appendChild(btnWrap);
      }
      ul.appendChild(li);
    }
    return [scoresDiv, ul];
  }, data.amenities_access);

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
      li.innerHTML = `<strong>${level}:</strong> ${details.name} (${details.distance_mi} mi)`;
      const button = document.createElement('button');
      button.textContent = 'Get Details';
      button.addEventListener('click', () => getPlaceDetails(details.name, data.address, button));
      li.appendChild(button);
      ul.appendChild(li);
    }
    return [ul];
  }, data.schools);

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
      if (d.price_per_sqft && d.price_per_sqft.value) addStat('Price / SqFt', '$'+d.price_per_sqft.value.toLocaleString(undefined,{maximumFractionDigits:0}));
      const chartDiv = document.createElement('div'); chartDiv.id = 'propertyValueChart'; chartDiv.className='pv-chart';
      // Chart mode toggle if PPSF present
      let chartMode = 'value';
      let modeToggle = null;
      if (d.price_per_sqft && d.price_per_sqft.series) {
        modeToggle = document.createElement('div');
        modeToggle.style.display='flex'; modeToggle.style.justifyContent='flex-end'; modeToggle.style.gap='6px'; modeToggle.style.marginBottom='4px';
        ['value','ppsf'].forEach(m=>{ const btn=document.createElement('button'); btn.type='button'; btn.textContent= m==='value' ? 'Median Value' : 'Price / SqFt'; btn.style.padding='4px 10px'; btn.style.fontSize='11px'; btn.style.borderRadius='14px'; btn.style.border='1px solid #e2e8f0'; btn.style.background= m===chartMode ? '#4f46e5' : 'transparent'; btn.style.color= m===chartMode ? '#fff' : '#334155'; btn.addEventListener('click',()=>{ chartMode=m; Array.from(modeToggle.children).forEach(c=>{ c.style.background='transparent'; c.style.color='#334155'; }); btn.style.background='#4f46e5'; btn.style.color='#fff'; renderChart(); }); modeToggle.appendChild(btn); });
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
        let categories, values, label;
        if (chartMode==='ppsf' && d.price_per_sqft && d.price_per_sqft.series) {
          const series = d.price_per_sqft.series;
          categories = series.map(p=>p.ym);
          values = series.map(p=>p.value);
          label = 'Price / SqFt';
        } else {
          const useMonthly = d.series && d.series.length > 2;
          if (useMonthly) { categories = d.series.map(p=>p.ym); values = d.series.map(p=>p.value); }
          else { categories = d.yearly.map(r=>r.year); values = d.yearly.map(r=>r.zhvi); }
          label = 'Median Value';
        }
        const options = {
          series:[{ name: label, data: values }],
          chart:{ type:'area', height:260, toolbar:{show:false}, zoom:{enabled:false}, animations:{enabled:true} },
          stroke:{ curve:'smooth', width:2.5 },
          dataLabels:{ enabled:false },
          // Force x-axis to show only the 4-digit year (e.g. 2025) regardless of monthly or yearly category values.
          xaxis:{ type:'category', categories, tickAmount: Math.min(10, Math.max(3, Math.floor(categories.length/3))), labels:{ rotate:0, style:{ colors:'#64748b', fontSize:'11px' }, formatter:(val)=>{ if(val===undefined||val===null) return ''; const s=val.toString(); // expect formats YYYY or YYYY-MM
              if(/^\d{4}-\d{2}$/.test(s)) return s.slice(0,4); if(/^\d{4}$/.test(s)) return s; // fallback: first 4 digits
              const m = s.match(/(19|20)\d{2}/); return m?m[0]:s; } }, axisBorder:{show:false}, axisTicks:{show:false} },
          yaxis:{ labels:{ style:{ colors:'#64748b', fontSize:'12px' }, formatter:(v)=>'$'+(v>=1_000_000?(v/1_000_000).toFixed(1)+'M':(v/1000).toFixed(0)+'K') } },
          grid:{ borderColor:'#f1f5f9', strokeDashArray:4 },
          tooltip:{ y:{ formatter:(val)=>'$'+val.toLocaleString() } },
          fill:{ type:'gradient', gradient:{ shadeIntensity:1, opacityFrom:0.35, opacityTo:0.05, stops:[0,100] } },
          markers:{ size:0, hover:{size:5} },
          colors:['#4f46e5']
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
