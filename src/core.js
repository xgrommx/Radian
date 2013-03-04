// Process attributes for plot directives.  All attributes, except for
// a small number of special cases (ID, CLASS, NG-*) are added as
// Angular scope variables, along with some extra information about
// the free variables and the original expression for the attribute.
// Changes to the attribute value are processed by re-evaluation using
// $observe and changes to free variables in the Radian expression are
// processed using a (slightly complicated) setup of scope.$watch
// listeners.

//===> THERE MIGHT BE ONE NASTY THING HERE.  WE MIGHT NEED TO
//     TRANSLATE "{{expr}}" INTO "scope.$eval(expr)" IN radianEval.
//     I'M MEDIUM CONVINCED THAT THIS SHOULDN'T BE A PROBLEM.  HERE'S
//     THE POSSIBLE CHAIN OF EVENTS CASING TROUBLE: YOU SET UP AN
//     ATTRIBUTE WITH AN EXPRESSION CONTAINING BOTH A FREE VARIABLE
//     AND A "{{expr}}" THING.  ANGULAR SHOULD IMMEDIATELY INTERPOLATE
//     THE "{{expr}}" SO THAT WE NEVER SEE IT, IN WHICH CASE CHANGES
//     TO THE "expr" SHOULD BE DEALT WITH BY A $observe.  CHANGES TO
//     THE FREE VARIABLE (WHICH WILL REQUIRE A RE-EVALUATION OF THE
//     EXPRESSION) SHOULD GO OFF O.K., SINCE THE STORED EXPRESSION HAS
//     ALREADY HAD ITS "{{expr}}" BITS INTERPOLATED BY ANGULAR.
//     THERE, I CONVINCED MYSELF IT WOULD ALL BE ALL RIGHT...

radian.factory('processAttrs', ['radianEval', function(radianEval) {
  'use strict';

  return function(scope, as) {
    scope.$$radianVars = { };
    Object.keys(as).forEach(function(a) {
      // Skip the specials.
      if (a == "id" || a == "class" || a.charAt(0) == "$" ||
          a.search(/^ng[A-Z]/) != -1) return;

      // Passing the true flag to radianEval gets us the free
      // variables in the expression as well as the current expression
      // value.
      var val = radianEval(scope, as[a], true, true);

      // Record the original expression and its free variables and set
      // the value of the scope variable.
      scope.$$radianVars[a] = { fvs: val[1], expr: as[a] };
      scope[a] = val[0];

      // Set up watchers for each of the free variables in the
      // expression.  When these watchers are triggered, they just
      // re-evaluate the expression for the attribute using its
      // original textual form.  We keep track of the return values
      // from the calls to scope.$watch so that we can cancel these
      // watches later if the free variables change.
      var entry = scope.$$radianVars[a];
      entry.fvwatchers = { };
      entry.fvs.forEach(function(v) {
        entry.fvwatchers[v] = scope.$watch(v, function() {
          scope[a] = radianEval(scope, entry.expr);
        }, true);
      });

      // Observe the value of the attribute: if the value (i.e. the
      // expression) changes, we pull in the new expression,
      // re-evaluate and rearrange the free variable watchers.
      as.$observe(a, function(v) {
        entry.expr = v;
        var val = radianEval(scope, v, true);
        scope[a] = val[0];
        entry.fvs = val[1];
        Object.keys(entry.fvwatchers).forEach(function(v) {
          // The new free variables are already in entry.fvs.  If this
          // one isn't in there, deregister the watch and remove it.
          if (entry.fvs.indexOf(v) == -1) {
            entry.fvwatchers[v]();
            delete entry.fvwatchers[v];
          }
        });
        // Add watchers for any new free variables.
        entry.fvs.forEach(function(v) {
          if (!entry.fvwatchers[v])
            entry.fvwatchers[v] = scope.$watch(v, function() {
              scope[a] = radianEval(scope, entry.expr);
            }, true);
        });
      });
    });
  };
}]);


// Main plot directive.  Kind of complicated...

radian.directive('plot',
 ['processAttrs', '$timeout', '$rootScope', 'dumpScope', 'dft', 'radianLegend',
 function(processAttrs, $timeout, $rootScope, dumpScope, dft, radianLegend)
{
  'use strict';

  // We do setup work here so that we can organise things before the
  // transcluded plotting directives are linked.
  function preLink(scope, elm, as, transclude) {
    // Process attributes, bringing all but a few special cases into
    // Angular scope as regular variables (to be use in data access
    // expressions).
    processAttrs(scope, as);

    // Deal with plot dimension attributes: explicit attribute values
    // override CSS values.  Do sensible things with width, height and
    // aspect ratio...
    var h = 300, asp = 1.618, w = asp * h;
    var aw = as.width, ah = as.height, aasp = as.aspect;
    var cw = elm.width(), ch = elm.height();
    var casp = elm.css('aspect') ? parseFloat(elm.css('aspect')) : null;
    if (aw && ah && aasp || ah && aw) { h = ah; w = aw; asp = w / h; }
    else if (ah && aasp) { h = ah; asp = aasp; w = h * asp; }
    else if (aw && aasp) { w = aw; asp = aasp; h = w / asp; }
    else if (ah) {
      h = ah;
      if (cw) { w = cw; asp = w / h; }
      else if (casp) { asp = casp; w = h * asp; }
      else { w = h * asp; }
    } else if (aw) {
      w = aw;
      if (ch) { h = ch; asp = w / h; }
      else if (casp) { asp = casp; h = w / asp; }
      else { h = w / asp; }
    } else if (aasp) {
      asp = aasp;
      if (cw) { w = cw; h = w / asp; }
      else if (ch) { h = ch; w = h * asp; }
      else { w = h * asp; }
    } else if (ch && cw) { h = ch; w = cw; asp = w / h; }
    else if (ch && casp) { h = ch; asp = casp; w = h * asp; }
    else if (cw && casp) { w = cw; asp = casp; h = w / asp; }
    else if (ch) { h = ch; w = h * asp; }
    else if (cw) { w = cw; h = w / asp; }
    else if (casp) { asp = casp; h = w / asp; }
    scope.width = w; scope.height = h;
    scope.svg = elm.children()[1];
    $(elm).css('width', w).css('height', h);

    // Set up view list and function for child elements to add plots.
    scope.views = [];
    scope.switchable = [];
    scope.addPlot = function(s) {
      if (scope.hasOwnProperty('legendSwitches')) scope.switchable.push(s);
      s.enabled = true;
    };

    transclude(scope.$new(), function (cl) { elm.append(cl); });
  };

  // We do the actual plotting after the transcluded plot type
  // elements are linked.
  function postLink(scope, elm) {
    function redraw() {
      scope.views.forEach(function(v) { draw(v, scope); });
    };
    function reset() {
      scope.views = svgs.map(function(s, i) {
        return setup(scope, s, i, svgs.length);
      });
      if (setupBrush) setupBrush();
      redraw();
    };

    // Set up plot areas (including zoomers).
    var svgelm = d3.select(scope.svg);
    if (scope.uivisible)
      scope.height -= parseInt($(elm.children()[0]).css('height'));
    svgelm.attr('width', scope.width).attr('height', scope.height);
    var mainsvg = svgelm.append('g')
      .attr('width', scope.width).attr('height', scope.height);
    var svgs = [mainsvg];
    var setupBrush = null;
    if (scope.hasOwnProperty('zoomX')) {
      var zfrac = scope.zoomFraction || 0.2;
      zfrac = Math.min(0.95, Math.max(0.05, zfrac));
      var zoomHeight = (scope.height - 6) * zfrac;
      var mainHeight = (scope.height - 6) * (1 - zfrac);
      var zoomsvg = svgelm.append('g')
        .attr('transform', 'translate(0,' + (mainHeight + 6) + ')')
        .attr('width', scope.width).attr('height', zoomHeight);
      svgs.push(zoomsvg);
      svgs[0].attr('height', mainHeight);

      setupBrush = function() {
        svgelm.append('defs').append('clipPath')
          .attr('id', 'xzoomclip')
          .append('rect')
          .attr('width', scope.views[0].realwidth)
          .attr('height', scope.views[0].realheight);
        scope.views[0].clip = 'xzoomclip';
        var brush = d3.svg.brush().x(scope.views[1].x);
        brush.on('brush', function() {
          scope.views[0].x.domain(brush.empty() ?
                                  scope.views[1].x.domain() : brush.extent());
          draw(scope.views[0], scope);
        });
        scope.views[1].post = function(svg) {
          svg.append('g')
            .attr('class', 'x brush')
            .call(brush)
            .selectAll('rect')
            .attr('y', -6)
            .attr('height', scope.views[1].realheight + 7);
        }
      };
    }

    $timeout(function() {
      // Draw plots and legend.
      reset();
      radianLegend(svgelm, scope);

      // Register plot data change handlers.
      scope.$on('paintChange', redraw);
      scope.$on('dataChange', reset);

      // Register UI event handlers.
      scope.$watch('strokesel', redraw);
      scope.$watch('xidx', reset);
      scope.$watch('yidx', reset);
    }, 0);

    // Set up interactivity.
    // ===> TODO: zoom and pan
    // ===> TODO: "layer" visibility
    // ===> TODO: styling changes
  };


  function setup(scope, topgroup, idx, nviews) {
    var v = { svg: topgroup };

    // Determine data ranges to use for plot -- either as specified in
    // X-RANGE, Y-RANGE or RANGE attributes on the plot element, or
    // the union of the data ranges for all plots.
    if (scope.hasOwnProperty("range") ||
        scope.hasOwnProperty("rangeX") || scope.hasOwnProperty("rangeY")) {
      var xrange, yrange;
      if (scope.hasOwnProperty("range")) {
        var ranges = scope.range.split(";");
        if (ranges.length == 2) {
          xrange = ranges[0];
          yrange = ranges[1];
        }
      }
      if (scope.hasOwnProperty("rangeX")) xrange = scope.rangeX;
      if (scope.hasOwnProperty("rangeY")) yrange = scope.rangeY;
      if (xrange) {
        var xs = xrange.split(","), vals = xs.map(parseFloat);
        var ok = false, ext = null;
        if (xs.length == 2 && xs[0] && xs[1]) {
          // "min,max"
          if (!isNaN(vals[0]) && !isNaN(vals[1])) {
            ok = true; ext = [vals[0], vals[1]];
            scope.fixedXRange = true;
            scope.xextent = ext;
          }
        } else if (xs.length == 1 || xs.length == 2 && !xs[1]) {
          // "min" or "min,"
          if (!isNaN(vals[0])) { ok = true;  ext = [vals[0], null]; }
        } else if (xs.length == 2 && !xs[0]) {
          // ",max"
          if (!isNaN(vals[1])) { ok = true;  ext = [null, vals[1]]; }
        }
        if (ok) scope.xrange = ext;
      }
      if (yrange) {
        var ys = yrange.split(","), vals = ys.map(parseFloat);
        var ok = false, ext = null;
        if (ys.length == 2 && ys[0] && ys[1]) {
          // "min,max"
          if (!isNaN(vals[0]) && !isNaN(vals[1])) {
            ok = true; ext = [vals[0], vals[1]];
            scope.fixedYRange = true;
            scope.yextent = ext;
          }
        } else if (ys.length == 1 || ys.length == 2 && !ys[1]) {
          // "min" or "min,"
          if (!isNaN(vals[0])) { ok = true;  ext = [vals[0], null]; }
        } else if (ys.length == 2 && !ys[0]) {
          // ",max"
          if (!isNaN(vals[1])) { ok = true;  ext = [null, vals[1]]; }
        }
        if (ok) scope.yrange = ext;
      }
    }
    function aext(d) {
      if (d[0] instanceof Array) {
        return d3.merge(d.map(function(a) { return d3.extent(a); }));
      } else
        return d3.extent(d);
    };
    function aext2(d, d2, d2min, d2max) {
      if (d[0] instanceof Array) {
        return d3.merge(d.map(function(a) {
          return d3.extent(a.filter(function(x, i) {
            return d2[i] >= d2min && d2[i] <= d2max;
          }));
        }));
      } else
        return d3.extent(d.filter(function(x, i) {
          return d2[i] >= d2min && d2[i] <= d2max;
        }));
    };
    var xexts = [], yexts = [], hasdate = false;
    var xextend = [0, 0], yextend = [0, 0];
    var x2exts = [], y2exts = [], hasdate2 = false;
    dft(scope, function(s) {
      if (!scope.fixedXRange && s.enabled && s.x)
        xexts = xexts.concat(aext(s.x));
      if (!scope.x2extent && s.enabled && s.x2)
        x2exts = x2exts.concat(aext(s.x2));
      if (!scope.fixedYRange && s.enabled && s.y) {
        if (scope.fixedXRange)
          yexts = yexts.concat(aext2(s.y, s.x,
                                     scope.xextent[0], scope.xextent[1]));
        else yexts = yexts.concat(aext(s.y));
      }
      if (!scope.y2extent && s.enabled && s.y2) {
        if (scope.xextent)
          y2exts = y2exts.concat(aext2(s.y2, s.x,
                                       scope.xextent[0], scope.xextent[1]));
        else y2exts = y2exts.concat(aext(s.y2));
      }
      if (s.x && s.x.metadata && s.x.metadata.format == 'date')
        hasdate = true;
      if (s.x2 && s.x2.metadata && s.x2.metadata.format == 'date')
        hasdate2 = true;
      if (s.rangeXExtend) {
        xextend[0] = Math.max(xextend[0], s.rangeXExtend[0]);
        xextend[1] = Math.max(xextend[1], s.rangeXExtend[1]);
      }
      if (s.rangeYExtend) {
        yextend[0] = Math.max(yextend[0], s.rangeYExtend[0]);
        yextend[1] = Math.max(yextend[1], s.rangeYExtend[1]);
      }
    });
    if (!scope.fixedXRange && xexts.length > 0) {
      scope.xextent = d3.extent(xexts);
      console.log("hasdate=" + hasdate);
      console.log("1: xextent=" + JSON.stringify(scope.xextent));
      if (scope.xrange) {
        if (scope.xrange[0] != null)
          scope.xextent[0] = Math.min(scope.xextent[0], scope.xrange[0]);
        if (scope.xrange[1] != null)
          scope.xextent[1] = Math.max(scope.xextent[1], scope.xrange[1]);
      }
      if (!hasdate) {
        scope.xextent[0] -= xextend[0];
        scope.xextent[1] += xextend[1];
      }
    }
    if (!scope.fixedYRange && yexts.length > 0) {
      scope.yextent = d3.extent(yexts);
      if (scope.yrange) {
        if (scope.yrange[0] != null)
          scope.yextent[0] = Math.min(scope.yextent[0], scope.yrange[0]);
        if (scope.yrange[1] != null)
          scope.yextent[1] = Math.max(scope.yextent[1], scope.yrange[1]);
      }
      scope.yextent[0] -= yextend[0];
      scope.yextent[1] += yextend[1];
    }
    if (!scope.x2extent && x2exts.length > 0)
      scope.x2extent = d3.extent(x2exts);
    if (!scope.y2extent && y2exts.length > 0)
      scope.y2extent = d3.extent(y2exts);

    // Extract plot attributes.
    v.xaxis = !scope.axisX || scope.axisX != 'off';
    v.yaxis = !scope.axisY || scope.axisY != 'off';
    v.x2axis = scope.x2extent && (!scope.axisX2 || scope.axisX2 != 'off');
    v.y2axis = scope.y2extent && (!scope.axisY2 || scope.axisY2 != 'off');
    var showXAxisLabel = (nviews == 1 || nviews == 2 && idx == 1) &&
      (!scope.axisXLabel || scope.axisXLabel != 'off');
    var showYAxisLabel = !scope.axisYLabel || scope.axisYLabel != 'off';
    var showX2AxisLabel = (nviews == 1 || nviews == 2 && idx == 1) &&
      (!scope.axisX2Label || scope.axisX2Label != 'off');
    var showY2AxisLabel = !scope.axisY2Label || scope.axisY2Label != 'off';
    v.margin = { top: scope.topMargin || 2, right: scope.rightMargin || 10,
                 bottom: scope.bottomMargin || 2, left: scope.leftMargin || 2 };
    var xAxisTransform = scope.axisXTransform || "linear";
    var yAxisTransform = scope.axisYTransform || "linear";

    // Set up plot margins.
    if (v.xaxis) v.margin.bottom += 20 + (showXAxisLabel ? 15 : 0);
    if (v.yaxis) v.margin.left += 30 + (showYAxisLabel ? 22 : 0);
    if (v.x2axis) v.margin.top += 20 + (showX2AxisLabel ? 15 : 0);
    if (v.y2axis) v.margin.right += 30 + (showY2AxisLabel ? 22 : 0);
    v.realwidth = v.svg.attr('width') - v.margin.left - v.margin.right;
    v.realheight = v.svg.attr('height') - v.margin.top - v.margin.bottom;
    v.outw = v.realwidth + v.margin.left + v.margin.right;
    v.outh = v.realheight + v.margin.top + v.margin.bottom;

    // Set up D3 data ranges.
    function makeXScaler() {
      if (hasdate)
        v.x = d3.time.scale().range([0, v.realwidth]).domain(scope.xextent);
      else if (xAxisTransform == "log")
        v.x = d3.scale.log().range([0, v.realwidth])
          .domain(scope.xextent).clamp(true);
      else
        v.x = d3.scale.linear().range([0, v.realwidth])
          .domain(scope.xextent).clamp(true);
    }
    function makeX2Scaler() {
      if (hasdate2)
        v.x2 = d3.time.scale().range([0, v.realwidth]).domain(scope.x2extent);
      else if (xAxisTransform == "log")
        v.x2 = d3.scale.log().range([0, v.realwidth])
          .domain(scope.x2extent).clamp(true);
      else
        v.x2 = d3.scale.linear().range([0, v.realwidth])
          .domain(scope.x2extent).clamp(true);
    }
    function makeYScaler() {
      if (yAxisTransform == "log")
        v.y = d3.scale.log().range([v.realheight, 0])
          .domain(scope.yextent).clamp(true);
      else
        v.y = d3.scale.linear().range([v.realheight, 0])
          .domain(scope.yextent).clamp(true);
    };
    function makeY2Scaler() {
      if (yAxisTransform == "log")
        v.y2 = d3.scale.log().range([v.realheight, 0])
          .domain(scope.y2extent).clamp(true);
      else
        v.y2 = d3.scale.linear().range([v.realheight, 0])
          .domain(scope.y2extent).clamp(true);
    };
    makeXScaler();
    makeYScaler();
    if (scope.x2extent) makeX2Scaler();
    if (scope.y2extent) makeY2Scaler();
    if (scope.hasOwnProperty("axisXTransform"))
      scope.$watch('axisXTransform', function(n, o) {
        xAxisTransform = n || "linear";
        makeXScaler();
        if (scope.x2) makeX2Scaler();
        scope.views.forEach(function(v) { draw(v, scope); });
      });
    if (scope.hasOwnProperty("axisYTransform"))
      scope.$watch('axisYTransform', function(n, o) {
        yAxisTransform = n || "linear";
        makeYScaler();
        if (scope.y2) makeY2Scaler();
        scope.views.forEach(function(v) { draw(v, scope); });
      });

    // Figure out axis labels.
    function axisLabel(labelText, v, idxvar, selectvar, def) {
      var idx0 = null;
      if (!labelText) {
        dft(scope, function(s) {
          if (!labelText)
            if (s[v] && s[v].metadata && s[v].metadata.label) {
              labelText = s[v].metadata.label;
              if (s[v].metadata.units)
                labelText += ' (' + s[v].metadata.units + ')';
            }
          idx0 = idx0 || s[idxvar];
        });
        if (!labelText && scope[selectvar]) {
          var labs = scope[selectvar].split(',');
          labelText = labs[idx0];
        }
        if (!labelText) labelText = def;
      }
      return labelText;
    };
    if (showXAxisLabel)
      v.xlabel = axisLabel(scope.axisXLabel, 'x', 'xidx', 'selectX', 'X Axis');
    if (showYAxisLabel)
      v.ylabel = axisLabel(scope.axisYLabel, 'y', 'yidx', 'selectY', 'Y Axis');
    if (showX2AxisLabel)
      v.x2label = axisLabel(scope.axisX2Label, 'x2',
                            'xidx', 'selectX2', 'X2 Axis');
    if (showY2AxisLabel)
      v.y2label = axisLabel(scope.axisY2Label, 'y2',
                            'yidx', 'selectY2', 'Y2 Axis');

    return v;
  };

  function draw(v, scope) {
    // Clean out any pre-existing plots.
    $(v.svg[0]).empty();

    // Set up plot margins.
    var outsvg = v.svg.append('g').attr('width', v.outw).attr('height', v.outh);
    var svg = outsvg.append('g')
      .attr('transform', 'translate(' + v.margin.left + ',' +
                                        v.margin.top + ')');
    v.innersvg = svg;
    if (v.clip) svg.attr('clip-path', 'url(#' + v.clip + ')');

    // Draw D3 axes.
    if (v.xaxis && v.x) {
      var axis = d3.svg.axis()
        .scale(v.x).orient('bottom')
        .ticks(outsvg.attr('width') / 100);
      var dformat = '%Y-%m-%d';
      var has_date = false;
      dft(scope, function(s) {
        var x = s.x;
        if (x && x.metadata && x.metadata.format == 'date') {
          if (x.metadata.dateFormat) dformat = x.metadata.dateFormat;
          has_date = true;
        }
        has_date = false;
      });
      if (has_date) axis.tickFormat(d3.time.format(dformat));
      outsvg.append('g').attr('class', 'axis')
        .attr('transform', 'translate(' + v.margin.left + ',' +
              (+v.realheight + 4) + ')')
        .call(axis);
      if (v.xlabel)
        var xpos = 0, ypos = 35;
        outsvg.append('g').attr('class', 'axis-label')
        .attr('transform', 'translate(' +
              (+v.margin.left + v.realwidth / 2) +
              ',' + v.realheight + ')')
        .append('text')
        .attr('x', xpos).attr('y', ypos)
        .attr('text-anchor', 'middle').text(v.xlabel);
    }
    if (v.x2axis && v.x2) {
      var axis = d3.svg.axis()
        .scale(v.x2).orient('top')
        .ticks(outsvg.attr('width') / 100);
      var dformat = '%Y-%m-%d';
      var has_date = false;
      dft(scope, function(s) {
        var x = s.x2;
        if (x && x.metadata && x.metadata.format == 'date') {
          if (x.metadata.dateFormat) dformat = x.metadata.dateFormat;
          has_date = true;
        }
        has_date = false;
      });
      if (has_date) axis.tickFormat(d3.time.format(dformat));
      outsvg.append('g').attr('class', 'axis')
        .attr('transform', 'translate(' + v.margin.left + ',4)')
        .call(axis);
      if (v.x2label)
        var xpos = 0, ypos = 35;
        outsvg.append('g').attr('class', 'axis-label')
        .attr('transform', 'translate(' +
              (+v.margin.left + v.realwidth / 2) + ',0)')
        .append('text')
        .attr('x', xpos).attr('y', ypos)
        .attr('text-anchor', 'middle').text(v.x2label);
    }
    if (v.yaxis && v.y) {
      var axis = d3.svg.axis()
        .scale(v.y).orient('left')
        .ticks(outsvg.attr('height') / 36);
      outsvg.append('g').attr('class', 'axis')
        .attr('transform', 'translate(' + (+v.margin.left - 4) + ',0)')
        .call(axis);
      if (v.ylabel) {
        var xpos = 12, ypos = v.realheight / 2;
        outsvg.append('g').attr('class', 'axis-label')
        .append('text')
        .attr('x', xpos).attr('y', ypos)
        .attr('transform', 'rotate(-90,' + xpos + ',' + ypos + ')')
        .attr('text-anchor', 'middle').text(v.ylabel);
      }
    }
    if (v.y2axis && v.y2) {
      var axis = d3.svg.axis()
        .scale(v.y2).orient('right')
        .ticks(outsvg.attr('height') / 36);
      outsvg.append('g').attr('class', 'axis')
        .attr('transform', 'translate(' +
              (+v.realwidth + v.margin.left) + ',0)')
        .call(axis);
      if (v.y2label) {
        var xpos = v.realwidth + v.margin.left + 40, ypos = v.realheight / 2;
        outsvg.append('g').attr('class', 'axis-label')
        .append('text')
        .attr('x', xpos).attr('y', ypos)
        .attr('transform', 'rotate(-90,' + xpos + ',' + ypos + ')')
        .attr('text-anchor', 'middle').text(v.y2label);
      }
    }

    // Loop over plots, calling their draw functions one by one.
    if (v.x && v.y || v.x2 && v.y || v.x && v.y2 || v.x2 && v.y2) {
      dft(scope, function(s) {
        if (s.draw && s.enabled) {
          var xvar = false, yvar = false;
          var xscale, yscale;
          if (s.x)  { xvar = 'x';  xscale = v.x;  }
          if (s.x2) { xvar = 'x2'; xscale = v.x2; }
          if (s.y)  { yvar = 'y';  yscale = v.y;  }
          if (s.y2) { yvar = 'y2'; yscale = v.y2; }

          if (xvar && yvar) {
            // Append SVG group for this plot and draw the plot into it.
            var g = svg.append('g');
            var x = (s[xvar][0] instanceof Array) ?
              s[xvar][s.xidx ? s.xidx : 0] : s[xvar];
            var y = (s[yvar][0] instanceof Array) ?
              s[yvar][s.yidx ? s.yidx : 0] : s[yvar];
            s.draw(g, x, xscale, y, yscale, s, v.realwidth, v.realheight);
            s.$on('$destroy', function() { g.remove(); });
          }
        }
      });
      if (v.post) v.post(v.innersvg);
    }
  };

  return {
    restrict: 'E',
    template:
    ['<div class="radian">',
       '<radian-ui></radian-ui>',
       '<svg></svg>',
     '</div>'].join(""),
    replace: true,
    transclude: true,
    scope: true,
    compile: function(elm, as, trans) {
      return { pre: function(s, e, a) { preLink(s, e, a, trans); },
               post: postLink };
    }
  };
}]);


// Link function shared by most simple plotting directives.  Does
// attribute processing, hides HTML element, sets up drawing function
// and sets up event emitters for data and paint changes.

radian.factory('plotTypeLink', ['processAttrs', function(processAttrs)
{
  var paintas = [ 'orientation', 'fill', 'fillOpacity', 'label',
                  'marker', 'markerSize', 'stroke', 'strokeOpacity',
                  'strokeWidth' ];

  return function(scope, elm, as, draw) {
    processAttrs(scope, as);
    elm.hide();
    scope.draw = draw;
    scope.$parent.addPlot(scope);

    scope.$watch('x', function() { scope.$emit('dataChange', scope); });
    scope.$watch('y', function() { scope.$emit('dataChange', scope); });
    paintas.forEach(function(a) {
      if (scope.hasOwnProperty(a))
        scope.$watch(a, function() { scope.$emit('paintChange', scope); });
    });
  };
}]);


// Simple directive just to wrap inner plotting directives that share
// options.  Brings any attributes into scope and transcludes inner
// plot directives.

radian.directive('plotOptions', ['processAttrs', function(processAttrs)
{
  'use strict';

  return {
    restrict: 'E',
    template: '<div ng-transclude></div>',
    replace: true,
    transclude: true,
    scope: false,
    link: function(scope, elm, as) { processAttrs(scope, as); }
  };
}]);
