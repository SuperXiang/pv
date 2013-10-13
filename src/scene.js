// Copyright (c) 2013 Marco Biasini
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy 
// of this software and associated documentation files (the "Software"), to deal 
// in the Software without restriction, including without limitation the rights 
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell 
// copies of the Software, and to permit persons to whom the Software is 
// furnished to do so, subject to the following conditions:
// 
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE 
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, 
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE 
// SOFTWARE.
(function(exports) {

// A scene node holds a set of child nodes to be rendered on screen. Later on, 
// the SceneNode might grow additional functionality commonly found in a scene 
// graph, e.g. coordinate transformations.
function SceneNode(name) {
  this._children = [];
  this._visible = true;
  this._name = name || '';
}

SceneNode.prototype.add = function(node) {
  this._children.push(node);
};

SceneNode.prototype.draw = function(cam, shaderCatalog, style, pass) {
  for (var i = 0; i < this._children.length; ++i) {
    this._children[i].draw(cam, shaderCatalog, style, pass);
  }
};


SceneNode.prototype.show = function() {
  this._visible = true;
};

SceneNode.prototype.hide = function() {
  this._visible = false;
};

SceneNode.prototype.name = function(name) { 
  if (name !== undefined) {
    this._name = name;
  }
  return this._name; 
};

// During recoloring of a render style, most of the vertex attributes, e.g.
// normals and positions do not change. Only the color information for each
// vertex needs to be adjusted. 
//
// To do that efficiently, we need store an association between ranges of
// vertices and atoms in the original structure. Worse, we also need to 
// support render styles for which colors need to be interpolated, e.g.
// the smooth line trace, tube and cartoon render modes. 
//
// The vertex association data for the atom-based render styles is managed
// by AtomVertexAssoc, whereas the trace-based render styles are managed 
// by the TraceVertexAssoc class. 
function AtomVertexAssoc(structure, callColoringBeginEnd) {
  this._structure = structure;
  this._assocs = [];
  this._callBeginEnd = callColoringBeginEnd;

}

AtomVertexAssoc.prototype.addAssoc = function(atom, vertStart, vertEnd)  {
  this._assocs.push({ atom: atom, vertStart : vertStart, vertEnd : vertEnd });
};

AtomVertexAssoc.prototype.recolor = function(colorOp, view, buffer, offset, stride) {
  var colorData = new Float32Array(this._structure.atomCount()*3); 
  if (this._callBeginEnd) {
    // FIXME: does this need to be called on the complete structure or the 
    // view?
    colorOp.begin(this._structure);
  }
  var atomMap = {};
  view.eachAtom(function(atom, index) {
    atomMap[atom.index()] = index;
    colorOp.colorFor(atom, colorData, index*3);
  });
  if (this._callBeginEnd) {
    colorOp.end(this._structure);
  }
  for (var i = 0; i < this._assocs.length; ++i) {
    var assoc = this._assocs[i];
    var ai = atomMap[assoc.atom.index()];
    if (ai === undefined) {
      continue;
    }
    var r = colorData[ai*3], g = colorData[ai*3+1], b = colorData[ai*3+2];
    for (var j = assoc.vertStart ; j < assoc.vertEnd; ++j) {
       buffer[offset+j*stride+0] = r;  
       buffer[offset+j*stride+1] = g;  
       buffer[offset+j*stride+2] = b;  
    }
  }
};

function TraceVertexAssoc(structure, interpolation, callColoringBeginEnd) {
  this._structure = structure;
  this._assocs = [];
  this._callBeginEnd = callColoringBeginEnd;
  this._interpolation = interpolation || 1;
}

TraceVertexAssoc.prototype.addAssoc = function(traceIndex, slice, vertStart, vertEnd) {
  this._assocs.push({ traceIndex: traceIndex, slice : slice, vertStart : vertStart, 
                      vertEnd : vertEnd});
};


TraceVertexAssoc.prototype.recolor = function(colorOp, view, buffer, offset, 
                                              stride) {
  // FIXME: this function might create quite a few temporary buffers. Implement
  // a buffer pool to avoid hitting the GC and having to go through the slow
  // creation of typed arrays.
  if (this._callBeginEnd) {
    // FIXME: does this need to be called on the complete structure?
    colorOp.begin(this._structure);
  }
  var colorData = [];
  var i, j;
  var chains = view.chains();
  for (var ci = 0; ci < chains.length; ++ci) {
    var chain = chains[ci];
    var traces = chain.backboneTraces();
    for (i = 0; i < traces.length; ++i) {
      var data = new Float32Array(traces[i].length*3); 
      var index = 0;
      for (j = 0; j < traces[i].length; ++j) {
        colorOp.colorFor(traces[i][j].atom('CA'), data, index);
        index+=3;
      }
      if (this._interpolation>1) {
        colorData.push(interpolateColor(data, this._interpolation));
      } else {
        colorData.push(data);
      }
    }
  }
  for (i = 0; i < this._assocs.length; ++i) {
    var assoc = this._assocs[i];
    var ai = assoc.slice;
    var d = colorData[assoc.traceIndex];
    var r = d[ai*3], g = d[ai*3+1], b = d[ai*3+2];
    for (j = assoc.vertStart ; j < assoc.vertEnd; ++j) {
      buffer[offset+j*stride+0] = r;  
      buffer[offset+j*stride+1] = g;  
      buffer[offset+j*stride+2] = b;  
    }
  }
  if (this._callBeginEnd) {
    colorOp.end(this._structure);
  }
};


function BaseGeom(gl) {
  SceneNode.prototype.constructor.call(this, gl);
  this._gl = gl;
}


derive(BaseGeom, SceneNode);

BaseGeom.prototype.select = function(what) {
  return this.structure().select(what);
};

BaseGeom.prototype.structure = function() { return this._vertAssoc._structure; };

BaseGeom.prototype.setVertAssoc = function(assoc) {
  this._vertAssoc = assoc;
};

// Holds geometrical data for objects rendered as lines. For each vertex,
// the color and position is stored in an interleaved format.
function LineGeom(gl) {
  BaseGeom.prototype.constructor.call(this, gl);
  this._data = [];
  this._ready = false;
  this._interleavedBuffer = gl.createBuffer();
  this._numLines = 0;
  this._vertAssoc = null;
  this._lineWidth = 1.0;
}

derive(LineGeom, BaseGeom);

LineGeom.prototype.setLineWidth = function(width) {
  this._lineWidth = width;
};

LineGeom.prototype.shaderForStyleAndPass = function(shaderCatalog, style, pass) {
  if (pass === 'outline') {
    return null;
  }
  return shaderCatalog.lines;
};

LineGeom.prototype.numVerts = function() { return this._numLines*2; };

LineGeom.prototype.draw = function(cam, shaderCatalog, style, pass) {

  if (!this._visible) { return; }

  var shader = this.shaderForStyleAndPass(shaderCatalog, style, pass);
  if (!shader) { return; }
  cam.bind(shader);
  this.bind();
  this._gl.lineWidth(this._lineWidth);
  var vertAttrib = this._gl.getAttribLocation(shader, 'attrPos');
  this._gl.enableVertexAttribArray(vertAttrib);
  this._gl.vertexAttribPointer(vertAttrib, 3, this._gl.FLOAT, false, 6*4, 0*4);
  var clrAttrib = this._gl.getAttribLocation(shader, 'attrColor');
  this._gl.vertexAttribPointer(clrAttrib, 3, this._gl.FLOAT, false, 6*4, 3*4);
  this._gl.enableVertexAttribArray(clrAttrib);
  this._gl.drawArrays(this._gl.LINES, 0, this._numLines*2);
  this._gl.disableVertexAttribArray(vertAttrib);
  this._gl.disableVertexAttribArray(clrAttrib);
};


LineGeom.prototype.colorBy = function(colorFunc, view) {
  console.time('LineGeom.colorBy');
  this._ready = false;
  view = view || this.structure();
  this._vertAssoc.recolor(colorFunc, view, this._data, 3, 6);
  console.timeEnd('LineGeom.colorBy');
};

LineGeom.prototype.bind = function() {
  this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this._interleavedBuffer);
  if (this._ready) {
    return;
  }
  var floatArray = new Float32Array(this._data);
  this._gl.bufferData(this._gl.ARRAY_BUFFER, floatArray, this._gl.STATIC_DRAW);
  this._ready = true;
};

LineGeom.prototype.addLine = function(startPos, startColor, endPos, endColor) {
  this._data.push(startPos[0], startPos[1], startPos[2],
                  startColor[0], startColor[1], startColor[2],
                  endPos[0], endPos[1], endPos[2],
                  endColor[0], endColor[1], endColor[2]);
  this._numLines += 1;
  this._ready = false;
};

// a SceneNode which aggregates one or more (unnamed) geometries into one
// named object. It forwards coloring and configuration calls to all
// geometries it contains. 
//
// FIXME: CompositeGeom could possibly be merged directly into the 
// SceneNode by introducing named and unnamed child nodes at the SceneNode
// level. It only exists to support unnamed child nodes and hide the fact
// that some render styles require multiple MeshGeoms to be constructed.
function CompositeGeom(structure) {
  BaseGeom.prototype.constructor.call(this, null);
  this._geoms = [];
  this._structure = structure;
}

derive(CompositeGeom, BaseGeom);


CompositeGeom.prototype.addGeom = function(geom) {
  this._geoms.push(geom);
};


CompositeGeom.prototype.structure = function() { 
  return this._structure;
};

CompositeGeom.prototype.forwardMethod = function(method, args) {
  for (var i = 0; i < this._geoms.length; ++i) {
    this._geoms[i][method].apply(this._geoms[i], args);
  }
};

CompositeGeom.prototype.colorBy = function() {
  var colorFunc = arguments[0];
  colorFunc.begin(this._structure);
  this.forwardMethod('colorBy', arguments);
  colorFunc.end(this._structure);
};

CompositeGeom.prototype.draw = function(cam, shaderCatalog, style, pass) {
  if (!this._visible) {
    return;
  }
  for (var i = 0; i < this._geoms.length; ++i) {
    this._geoms[i].draw(cam, shaderCatalog, style, pass);
  }
};


function ProtoSphere(stacks, arcs) {
  this._arcs = arcs;
  this._stacks = stacks;
  this._indices = new Uint16Array(3*arcs*stacks*2);
  this._verts = new Float32Array(3*arcs*stacks);
  var vert_angle = Math.PI/(stacks-1);
  var horz_angle = Math.PI*2.0/arcs;
  var i, j;
  for (i = 0; i < this._stacks; ++i) {
    var radius = Math.sin(i*vert_angle);
    var z = Math.cos(i*vert_angle);
    for (j = 0; j < this._arcs; ++j) {
      var nx = radius*Math.cos(j*horz_angle);
      var ny = radius*Math.sin(j*horz_angle);
      this._verts[3*(j+i*this._arcs)] = nx;
      this._verts[3*(j+i*this._arcs)+1] = ny;
      this._verts[3*(j+i*this._arcs)+2] = z;
    }
  }
  var index = 0;
  for (i = 0; i < this._stacks-1; ++i) {
    for (j = 0; j < this._arcs; ++j) {
      this._indices[index] = (i)*this._arcs+j;
      this._indices[index+1] = (i)*this._arcs+((j+1) % this._arcs);
      this._indices[index+2] = (i+1)*this._arcs+j;

      index += 3;
      
      this._indices[index] = (i)*this._arcs+((j+1) % this._arcs);
      this._indices[index+1] = (i+1)*this._arcs+((j+1) % this._arcs);
      this._indices[index+2] = (i+1)*this._arcs+j;
      index += 3;
    }
  }
}

ProtoSphere.prototype.addTransformed = (function() {
  
  var pos = vec3.create(), normal = vec3.create();

  return function(geom, center, radius, color) {
    var baseIndex = geom.numVerts();
    for (var i = 0; i < this._stacks*this._arcs; ++i) {
      vec3.set(normal, this._verts[3*i], this._verts[3*i+1], 
                this._verts[3*i+2]);
      vec3.copy(pos, normal);
      vec3.scale(pos, pos, radius);
      vec3.add(pos, pos, center);
      geom.addVertex(pos, normal, color);
    }
    for (i = 0; i < this._indices.length/3; ++i) {
      geom.addTriangle(baseIndex+this._indices[i*3], 
                      baseIndex+this._indices[i*3+1], 
                      baseIndex+this._indices[i*3+2]);
    }
  };
})();

ProtoSphere.prototype.num_indices = function() { 
  return this._indices.length; 
};

ProtoSphere.prototype.num_vertices = function() { 
  return this._verts.length; 
};

// A tube profile is a cross-section of a tube, e.g. a circle or a 'flat' square.
// They are used to control the style of helices, strands and coils for the 
// cartoon render mode. 
function TubeProfile(points, num, strength) {
  var interpolated = geom.catmullRomSpline(points, num, strength, true);

  this._indices = new Uint16Array(interpolated.length*2);
  this._verts = interpolated;
  this._normals = new Float32Array(interpolated.length);
  this._arcs = interpolated.length/3;

  var normal = vec3.create(), pos = vec3.create();

  for (var i = 0; i < this._arcs; ++i) {
    var i_prev = i === 0 ? this._arcs-1 : i-1;
    var i_next = i === this._arcs-1 ? 0 : i+1;
    normal[0] = this._verts[3*i_next+1] - this._verts[3*i_prev+1];
    normal[1] = this._verts[3*i_prev] - this._verts[3*i_next];
    vec3.normalize(normal, normal);
    this._normals[3*i] = normal[0];
    this._normals[3*i+1] = normal[1];
    this._normals[3*i+2] = normal[2];
  }

  for (i = 0; i < this._arcs; ++i) {
    this._indices[6*i] = i;
    this._indices[6*i+1] = i+this._arcs;
    this._indices[6*i+2] = ((i+1) % this._arcs) + this._arcs;
    this._indices[6*i+3] = i;
    this._indices[6*i+4] = ((i+1) % this._arcs) + this._arcs;
    this._indices[6*i+5] = (i+1) % this._arcs;
  }
}

TubeProfile.prototype.addTransformed = (function() {
  var pos = vec3.create(), normal = vec3.create();
  return function(geom, center, radius, rotation, color, first,
                              offset) {
    var baseIndex = geom.numVerts() - this._arcs;
    for (var i = 0; i < this._arcs; ++i) {
      vec3.set(pos, radius*this._verts[3*i], radius*this._verts[3*i+1], 0.0);
      vec3.transformMat3(pos, pos, rotation);
      vec3.add(pos, pos, center);
      vec3.set(normal, this._normals[3*i], this._normals[3*i+1], 0.0);
      vec3.transformMat3(normal, normal, rotation);
      geom.addVertex(pos, normal, color);
    }
    if (first) {
      return;
    }
    if (offset === 0) {
      // that's what happens most of the time, thus is has been optimized.
      for (i = 0; i < this._indices.length/3; ++i) {
        geom.addTriangle(baseIndex+this._indices[i*3], 
                          baseIndex+this._indices[i*3+1], 
                          baseIndex+this._indices[i*3+2]);
      }
      return;
    }
    for (i = 0; i < this._arcs; ++i) {
      geom.addTriangle(baseIndex+((i+offset) % this._arcs),
                        baseIndex+i+this._arcs,
                        baseIndex+((i+1) % this._arcs) + this._arcs);
      geom.addTriangle(baseIndex+(i+offset) % this._arcs,
                        baseIndex+((i+1) % this._arcs) + this._arcs,
                        baseIndex+((i+1+offset) % this._arcs));
    }

  };
})();


function ProtoCylinder(arcs) {
  this._arcs = arcs;
  this._indices = new Uint16Array(arcs*3*2);
  this._verts = new Float32Array(3*arcs*2);
  this._normals = new Float32Array(3*arcs*2);
  var angle = Math.PI*2/this._arcs;
  for (var i = 0; i < this._arcs; ++i) {
    var cos_angle = Math.cos(angle*i);
    var sin_angle = Math.sin(angle*i);
    this._verts[3*i] = cos_angle;
    this._verts[3*i+1] = sin_angle;
    this._verts[3*i+2] = -0.5;
    this._verts[3*arcs+3*i] = cos_angle;
    this._verts[3*arcs+3*i+1] = sin_angle;
    this._verts[3*arcs+3*i+2] = 0.5;
    this._normals[3*i] = cos_angle;
    this._normals[3*i+1] = sin_angle;
    this._normals[3*arcs+3*i] = cos_angle;
    this._normals[3*arcs+3*i+1] = sin_angle;
  }
  for (i = 0; i < this._arcs; ++i) {
    this._indices[6*i] = (i) % this._arcs;
    this._indices[6*i+1] = arcs+((i+1) % this._arcs);
    this._indices[6*i+2] = (i+1) % this._arcs;

    this._indices[6*i+3] = (i) % this._arcs;
    this._indices[6*i+4] = arcs+((i) % this._arcs);
    this._indices[6*i+5] = arcs+((i+1) % this._arcs);
  }
}

ProtoCylinder.prototype.addTransformed = (function() {
  var pos = vec3.create(), normal = vec3.create();
  return function(geom, center, length, radius, rotation, colorOne, 
                              colorTwo) {
    var baseIndex = geom.numVerts();
    for (var i = 0; i < 2*this._arcs; ++i) {
      vec3.set(pos, radius*this._verts[3*i], radius*this._verts[3*i+1], 
                length*this._verts[3*i+2]);
      vec3.transformMat3(pos, pos, rotation);
      vec3.add(pos, pos, center);
      vec3.set(normal, this._normals[3*i], this._normals[3*i+1], this._normals[3*i+2]);
      vec3.transformMat3(normal, normal, rotation);
      geom.addVertex(pos, normal, i < this._arcs ? colorOne : colorTwo);
    }
    for (i = 0; i < this._indices.length/3; ++i) {
      geom.addTriangle(baseIndex+this._indices[i*3], 
                        baseIndex+this._indices[i*3+1], 
                        baseIndex+this._indices[i*3+2]);
    }
  };
})();

// an (indexed) mesh geometry container.
//
// stores the vertex data in interleaved format. not doing so has severe 
// performance penalties in WebGL, and severe means orders of magnitude 
// slower than using an interleaved array.
//
// the vertex data is stored in the following format;
//
// Px Py Pz Nx Ny Nz Cr Cg Cb
//
// , where P is the position, N the normal and C the color information
// of the vertex.
function MeshGeom(gl) {
  BaseGeom.prototype.constructor.call(this, gl);
  this._interleavedBuffer = gl.createBuffer();
  this._indexBuffer = gl.createBuffer();
  this._vertData = [];
  this._indexData = [];
  this._numVerts = 0;
  this._numTriangles = 0;
  this._ready = false;
  this._vertAssoc = null;
}

derive(MeshGeom, BaseGeom);

MeshGeom.prototype.setVertAssoc = function(assoc) {
  this._vertAssoc = assoc;
};

MeshGeom.prototype.numVerts = function() { return this._numVerts; };

MeshGeom.prototype.shaderForStyleAndPass = function(shaderCatalog, style, pass) {
  if (pass === 'outline') {
    return shaderCatalog.outline;
  }
  var shader = shaderCatalog[style];
  return shader !== undefined ? shader : null;
};


MeshGeom.prototype.colorBy = function(colorFunc, view) {
  console.time('MeshGeom.colorBy');
  this._ready = false;
  view = view || this.structure();
  this._vertAssoc.recolor(colorFunc, view, this._vertData, 6, 9);
  console.timeEnd('MeshGeom.colorBy');
};

MeshGeom.prototype.draw = function(cam, shaderCatalog, style, pass) {

  if (!this._visible) { return; }
  
  var shader = this.shaderForStyleAndPass(shaderCatalog, style, pass);
  if (!shader) { return; }
  cam.bind(shader);
  this.bind();

  var posAttrib = this._gl.getAttribLocation(shader, 'attrPos');
  this._gl.enableVertexAttribArray(posAttrib);
  this._gl.vertexAttribPointer(posAttrib, 3, this._gl.FLOAT, false, 9*4, 0*4);

  var normalAttrib = this._gl.getAttribLocation(shader, 'attrNormal');
  if (normalAttrib !== -1) {
    this._gl.enableVertexAttribArray(normalAttrib);
    this._gl.vertexAttribPointer(normalAttrib, 3, this._gl.FLOAT, false, 
                                 9*4, 3*4);
  }

  var clrAttrib = this._gl.getAttribLocation(shader, 'attrColor');
  if (clrAttrib !== -1) {
    this._gl.vertexAttribPointer(clrAttrib, 3, this._gl.FLOAT, false, 9*4, 6*4);
    this._gl.enableVertexAttribArray(clrAttrib);
  }
  this._gl.drawElements(this._gl.TRIANGLES, this._numTriangles*3, 
                        this._gl.UNSIGNED_SHORT, 0);
  this._gl.disableVertexAttribArray(posAttrib);
  if (clrAttrib !==-1) {
    this._gl.disableVertexAttribArray(clrAttrib);
  }
  if (normalAttrib !== -1) {
    this._gl.disableVertexAttribArray(normalAttrib);
  }
};

MeshGeom.prototype.addVertex = function(pos, normal, color) {
  // pushing all values at once seems to be more efficient than pushing
  // separately. resizing the vertData prior and setting the elements
  // is substantially slower.
  this._vertData.push(pos[0], pos[1], pos[2], normal[0], normal[1], normal[2],
                      color[0], color[1], color[2]);
  this._numVerts += 1;
};

MeshGeom.prototype.addTriangle = function(idx1, idx2, idx3) {
  this._indexData.push(idx1, idx2, idx3);
  this._numTriangles += 1;
};

MeshGeom.prototype.bind = function() {
  this._gl.bindBuffer(this._gl.ARRAY_BUFFER, this._interleavedBuffer);
  this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
  if (this._ready) {
    return;
  }
  var floatArray = new Float32Array(this._vertData);
  this._gl.bufferData(this._gl.ARRAY_BUFFER, floatArray, 
                      this._gl.STATIC_DRAW);
  var indexArray = new Uint16Array(this._indexData);
  this._gl.bufferData(this._gl.ELEMENT_ARRAY_BUFFER, indexArray, 
                      this._gl.STATIC_DRAW);
  this._ready = true;
};


exports.SceneNode = SceneNode;
exports.AtomVertexAssoc = AtomVertexAssoc;
exports.TraceVertexAssoc = TraceVertexAssoc;
exports.MeshGeom = MeshGeom;
exports.LineGeom = LineGeom;
exports.CompositeGeom = CompositeGeom;
exports.TubeProfile = TubeProfile;
exports.ProtoSphere = ProtoSphere;
exports.ProtoCylinder = ProtoCylinder;

})(this);
